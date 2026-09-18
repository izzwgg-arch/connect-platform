/**
 * Production smoke: estimate DocNumber QBO guard.
 * Run on server: npx tsx scripts/smoke-estimate-docnumber-prod.ts
 */
import { prisma } from '../lib/prisma'
import { generateAccessToken } from '../lib/auth'
import { getQboSessionForTenant } from '../lib/qbo/session'
import { quickBooksService } from '../lib/services/quickbooks'
import { tenantRequiresQboEstimateDocNumberCheck } from '../lib/qbo/doc-numbers'

const BASE = process.env.SMOKE_BASE_URL || 'https://app.trimprony.com'

async function main() {
  const user = await prisma.user.findFirst({
    where: { status: 'ACTIVE', allowWebLogin: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, tenantId: true, email: true, role: true },
  })
  if (!user) throw new Error('No active web user for smoke test')

  const token = generateAccessToken({
    userId: user.id,
    tenantId: user.tenantId,
    email: user.email,
    role: user.role,
  })
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }

  const requiresQbo = await tenantRequiresQboEstimateDocNumberCheck(user.tenantId)
  console.log('tenant', user.tenantId, 'requiresQbo', requiresQbo)

  let qboOnlyDocNumber: string | null = null
  if (requiresQbo) {
    const session = await getQboSessionForTenant(user.tenantId)
    if (!session) throw new Error('QuickBooks session unavailable for smoke test')
    const result = await quickBooksService.query(
      session.accessToken,
      session.realmId,
      "select DocNumber from Estimate where DocNumber != '' maxresults 100",
      { tenantId: user.tenantId, entityType: 'estimate', triggerSource: 'smoke_pick_existing_docnumber' }
    )
    const docs = (result?.QueryResponse?.Estimate || [])
      .map((row: any) => String(row?.DocNumber || '').trim())
      .filter(Boolean)
    for (const docNumber of docs) {
      const local = await prisma.estimate.findFirst({
        where: { estimateNumber: docNumber },
        select: { id: true },
      })
      if (!local) {
        qboOnlyDocNumber = docNumber
        break
      }
    }
    console.log('qboOnlyDocNumber', qboOnlyDocNumber || 'NONE_FOUND')
  } else {
    console.log('SKIP conflict test: QuickBooks not configured for tenant')
  }

  const beforeCount = await prisma.estimate.count()
  const smokeTitle = `SMOKE-DOCNUMBER-${Date.now()}`

  // A: QBO DocNumber not in TrimPro -> 409 QBO conflict, no row
  if (qboOnlyDocNumber) {
    const resA = await fetch(`${BASE}/api/estimates`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        estimateNumber: qboOnlyDocNumber,
        title: smokeTitle,
        lineItems: [],
      }),
    })
    const bodyA = await resA.json().catch(() => ({}))
    const afterA = await prisma.estimate.count()
    console.log('TEST_A', {
      status: resA.status,
      code: bodyA.code,
      error: bodyA.error,
      rowCreated: afterA > beforeCount,
      pass: resA.status === 409 && afterA === beforeCount && bodyA.code === 'ESTIMATE_NUMBER_QBO_CONFLICT',
    })
  } else if (requiresQbo) {
    console.log('TEST_A', { skipped: true, reason: 'no QBO-only DocNumber in sample' })
  }

  // B: free DocNumber -> 201
  const freeNumber = `SMOKE-EST-${Date.now()}`
  const resB = await fetch(`${BASE}/api/estimates`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      estimateNumber: freeNumber,
      title: `${smokeTitle}-free`,
      lineItems: [],
    }),
  })
  const bodyB = await resB.json().catch(() => ({}))
  console.log('TEST_B', {
    status: resB.status,
    estimateId: bodyB.estimate?.id,
    estimateNumber: bodyB.estimate?.estimateNumber,
    pass: resB.status === 201 && bodyB.estimate?.estimateNumber === freeNumber,
  })
  if (bodyB.estimate?.id) {
    await prisma.estimate.delete({ where: { id: bodyB.estimate.id } }).catch(() => {})
  }

  // C: next-number — flush logs, then ensure no QBO usage logged for that request
  const { execSync } = await import('child_process')
  execSync('pm2 flush trimpro', { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 400))
  const resC = await fetch(`${BASE}/api/estimates/next-number`, { headers: { Authorization: `Bearer ${token}` } })
  const bodyC = await resC.json().catch(() => ({}))
  await new Promise((r) => setTimeout(r, 1000))
  const logs = execSync('pm2 logs trimpro --lines 100 --nostream 2>/dev/null || true', {
    encoding: 'utf8',
    maxBuffer: 2_000_000,
  })
  const qboCallsInNewLog = logs.split('\n').filter((line) => line.includes('qbo_api_usage')).length
  console.log('TEST_C', {
    status: resC.status,
    estimateNumber: bodyC.estimateNumber,
    qboCallsInNewLog,
    pass: resC.status === 200 && typeof bodyC.estimateNumber === 'string' && qboCallsInNewLog === 0,
  })

  const sha = execSync('git rev-parse HEAD', { cwd: '/root/apps/trimpro', encoding: 'utf8' }).trim()
  console.log('DEPLOYED_SHA', sha)
}

main()
  .catch((e) => {
    console.error('SMOKE_FAILED', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
