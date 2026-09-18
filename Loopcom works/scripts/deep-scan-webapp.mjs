import fs from 'node:fs';
import path from 'node:path';

/**
 * Deep scan for common "works on Windows, breaks on Linux" issues:
 * - Import casing mismatches for @/ aliases
 * - fetch('/api/...') calls missing a matching app/api/<path>/route.ts
 *
 * Usage:
 *   node scripts/deep-scan-webapp.mjs
 */

const repoRoot = path.resolve(process.cwd());
const appDir = path.join(repoRoot, 'app');

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function walk(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function getRealPathCaseSensitive(targetPath) {
  // On Windows, fs.existsSync is case-insensitive; to detect casing mismatches
  // we resolve path segment-by-segment using directory listings.
  const abs = path.resolve(targetPath);
  const parsed = path.parse(abs);
  let cur = parsed.root;
  const rel = abs.slice(parsed.root.length);
  const parts = rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    const match = entries.find((e) => e.name === part);
    if (!match) return { ok: false, realPath: null };
    cur = path.join(cur, match.name);
  }
  return { ok: true, realPath: cur };
}

function resolveAliasedImport(importPath, fromFile) {
  if (!importPath.startsWith('@/')) return null;
  const rel = importPath.slice(2); // remove "@/"
  const base = path.join(repoRoot, rel);

  // Try a few common extensions and index files.
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Not found: return something helpful for reporting.
  return { missing: true, base, fromFile };
}

function extractImports(source) {
  const imports = new Set();
  const re = /\bfrom\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source))) {
    const p = m[1] || m[2];
    if (p) imports.add(p);
  }
  return Array.from(imports);
}

function extractApiFetchPaths(source) {
  const paths = new Set();
  const re = /fetch\s*\(\s*([`'"])([\s\S]*?)\1\s*[,\)]/g;
  let m;
  while ((m = re.exec(source))) {
    const p = m[2];
    if (!p) continue;
    // Ignore template strings with runtime interpolation - keep only the stable prefix.
    const stable = p.split('${')[0];
    if (stable.startsWith('/api/')) {
      // strip query/hash
      const clean = stable.split('?')[0].split('#')[0];
      paths.add(clean);
    }
  }
  return Array.from(paths);
}

function apiRouteFileFor(apiPath) {
  // Map "/api/foo/bar" -> "app/api/foo/bar/route.ts"
  const rel = apiPath.replace(/^\/api\//, '');
  const base = path.join(appDir, 'api', ...rel.split('/'));
  const candidates = [
    path.join(base, 'route.ts'),
    path.join(base, 'route.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const files = walk(repoRoot).filter((f) => CODE_EXTS.has(path.extname(f)));

const casingIssues = [];
const missingAliasedImports = [];
const api404s = [];

for (const file of files) {
  const src = readText(file);
  if (!src) continue;

  for (const imp of extractImports(src)) {
    const resolved = resolveAliasedImport(imp, file);
    if (!resolved) continue;
    if (resolved?.missing) {
      missingAliasedImports.push({ from: file, importPath: imp, base: resolved.base });
      continue;
    }

    // Verify path casing segment-by-segment.
    const caseCheck = getRealPathCaseSensitive(resolved);
    if (!caseCheck.ok) {
      casingIssues.push({ from: file, importPath: imp, resolved });
    }
  }

  for (const apiPath of extractApiFetchPaths(src)) {
    const routeFile = apiRouteFileFor(apiPath);
    if (!routeFile) api404s.push({ from: file, apiPath });
  }
}

function printSection(title, items) {
  console.log(`\n=== ${title} (${items.length}) ===`);
  for (const it of items.slice(0, 200)) {
    console.log(it);
  }
  if (items.length > 200) console.log(`... truncated (showing 200 of ${items.length})`);
}

printSection(
  'Missing @/ imports (likely runtime build crash on Linux)',
  missingAliasedImports.map((x) => `${path.relative(repoRoot, x.from)} -> ${x.importPath} (base: ${path.relative(repoRoot, x.base)})`)
);

printSection(
  'Import casing issues (likely Linux-only module not found)',
  casingIssues.map((x) => `${path.relative(repoRoot, x.from)} -> ${x.importPath} (resolved: ${path.relative(repoRoot, x.resolved)})`)
);

printSection(
  "fetch('/api/...') with no matching app/api/**/route.ts",
  api404s.map((x) => `${path.relative(repoRoot, x.from)} -> ${x.apiPath}`)
);

console.log('\nDone.');
