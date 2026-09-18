/**
 * Permission audit verification script.
 * Run: node scripts/permission-audit.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function walk(dir, ext = '.ts') {
  const results = []
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) results.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) results.push(full)
  }
  return results
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8')
}

// Parse permissions from catalog
const catalogPath = path.join(root, 'lib/permissions-catalog.ts')
const catalogSrc = readFile(catalogPath)
const permissionKeys = [...catalogSrc.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1])

// Parse route rules
const routeRulesPath = path.join(root, 'lib/route-permissions.ts')
const routeRulesSrc = readFile(routeRulesPath)
const routeRules = [...routeRulesSrc.matchAll(/prefix:\s*'([^']+)',\s*permission:\s*(?:'([^']+)'|\[([^\]]+)\])/g)].map((m) => ({
  prefix: m[1],
  permission: m[2] || m[3]?.split(',').map((s) => s.trim().replace(/['"]/g, '')),
}))

// Scan API routes
const apiDir = path.join(root, 'app/api')
const apiRoutes = walk(apiDir, '/route.ts'.length ? undefined : '.ts').filter((f) => f.endsWith('route.ts'))

const PERM_PATTERNS = [
  'requirePermission',
  'requireAnyPermission',
  'requireCrudPermission',
  'requireMethodPermissions',
  'requireMobilePermission',
]

const authOnlyRoutes = []
const protectedRoutes = []
const noAuthRoutes = []

for (const file of apiRoutes) {
  const src = readFile(file)
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const hasAuth = src.includes('authenticateRequest')
  const hasPerm = PERM_PATTERNS.some((p) => src.includes(p))

  if (!hasAuth) {
    noAuthRoutes.push(rel)
  } else if (!hasPerm) {
    // Allow self-service routes
    const allowed = [
      'app/api/me/route.ts',
      'app/api/auth/',
      'app/api/users/me/avatar/route.ts',
    ]
    if (!allowed.some((a) => rel.includes(a.replace('app/api/', '')) || rel.startsWith(a))) {
      authOnlyRoutes.push(rel)
    }
  } else {
    protectedRoutes.push(rel)
  }
}

// Sidebar permissions
const sidebarSrc = readFile(path.join(root, 'components/layout/sidebar.tsx'))
const navItems = [...sidebarSrc.matchAll(/name:\s*'([^']+)',\s*href:\s*'([^']+)'(?:,\s*icon:[^,]+,\s*permission:\s*'([^']+)')?/g)].map((m) => ({
  name: m[1],
  href: m[2],
  permission: m[3] || null,
}))

// Group permissions by module
const modules = {}
for (const key of permissionKeys) {
  const mod = key.split('.')[0]
  if (!modules[mod]) modules[mod] = []
  modules[mod].push(key)
}

const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    totalPermissions: permissionKeys.length,
    totalModules: Object.keys(modules).length,
    apiRoutesTotal: apiRoutes.length,
    apiRoutesProtected: protectedRoutes.length,
    apiRoutesAuthOnly: authOnlyRoutes.length,
    apiRoutesNoAuth: noAuthRoutes.length,
    routeRulesCount: routeRules.length,
    sidebarItemsTotal: navItems.length,
    sidebarItemsWithPermission: navItems.filter((n) => n.permission).length,
    sidebarItemsMissingPermission: navItems.filter((n) => !n.permission).length,
  },
  modules: Object.fromEntries(
    Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))
  ),
  routePermissionRules: routeRules,
  sidebarNavigation: navItems,
  apiRoutesAuthOnlyMissingPermissionCheck: authOnlyRoutes.sort(),
  frontendEnforcement: {
    routePermissionGuard: fs.existsSync(path.join(root, 'components/permissions/RoutePermissionGuard.tsx')),
    permissionGuard: fs.existsSync(path.join(root, 'components/layout/sidebar.tsx')),
    dashboardLayoutIntegration: readFile(path.join(root, 'components/layout/dashboard-layout.tsx')).includes('RoutePermissionGuard'),
    centralizedAuthorization: fs.existsSync(path.join(root, 'lib/authorization.ts')),
    apiGuards: fs.existsSync(path.join(root, 'lib/api-guards.ts')),
    permissionLogging: readFile(path.join(root, 'lib/authorization.ts')).includes('logPermissionDenied'),
  },
}

const outPath = path.join(root, 'demo-videos/permission-audit-report.json')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

console.log('Permission Audit Report')
console.log('=======================')
console.log(`Permissions in catalog: ${report.summary.totalPermissions}`)
console.log(`API routes protected: ${report.summary.apiRoutesProtected}/${report.summary.apiRoutesTotal}`)
console.log(`API routes auth-only (may need review): ${report.summary.apiRoutesAuthOnly}`)
console.log(`Sidebar items with permission: ${report.summary.sidebarItemsWithPermission}/${report.summary.sidebarItemsTotal}`)
console.log(`Route permission rules: ${report.summary.routeRulesCount}`)
console.log(`Report written to: ${outPath}`)

if (authOnlyRoutes.length > 0) {
  console.log('\nAuth-only routes (mobile/self-service - review if needed):')
  authOnlyRoutes.slice(0, 20).forEach((r) => console.log(`  - ${r}`))
  if (authOnlyRoutes.length > 20) console.log(`  ... and ${authOnlyRoutes.length - 20} more`)
}

process.exit(0)
