#!/usr/bin/env ts-node
/**
 * Safe production verification helper (read-only)
 *
 * Goals:
 * - Print only SET/MISSING for env keys
 * - Print only HTTP status codes (no URLs echoed)
 * - Print only aggregate counts for docker
 * - Never print secrets or raw values
 */
import { execFileSync } from 'child_process';
import https from 'https';
import http from 'http';

function parseArgs() {
  const args = process.argv.slice(2);
  const out: any = { env: [], http: null, dockerPattern: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--env' && args[i + 1]) { out.env = String(args[++i]).split(',').map((s) => s.trim()).filter(Boolean); continue; }
    if (a === '--http' && args[i + 1]) { out.http = String(args[++i]); continue; }
    if (a === '--docker-contains' && args[i + 1]) { out.dockerPattern = String(args[++i]); continue; }
  }
  return out;
}

async function httpStatus(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
        resolve(res.statusCode ?? null);
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

function dockerNames(): string[] | null {
  try {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return null; }
}

async function main() {
  const cfg = parseArgs();
  // Env checks (local process only)
  if (cfg.env && Array.isArray(cfg.env)) {
    for (const key of cfg.env) {
      const upper = key.toUpperCase();
      const val = process.env[upper];
      process.stdout.write(`${upper}=${val ? 'SET' : 'MISSING'}\n`);
    }
  }
  // HTTP status (do not echo URL)
  if (cfg.http) {
    const code = await httpStatus(cfg.http);
    process.stdout.write(`HTTP_STATUS=${code ?? 'UNKNOWN'}\n`);
  }
  // Docker containment (count only)
  if (cfg.dockerPattern) {
    const names = dockerNames();
    if (!names) process.stdout.write(`DOCKER_MATCH_COUNT=UNKNOWN\n`);
    else {
      const pat = new RegExp(cfg.dockerPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); // escape literal
      const count = names.filter((n) => pat.test(n)).length;
      process.stdout.write(`DOCKER_MATCH_COUNT=${count}\n`);
    }
  }
}

if (require.main === module) {
  main().catch(() => process.exit(1));
}
