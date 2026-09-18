import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/**
 * Lightweight health check.
 * Intended for debugging "server error everywhere" scenarios without leaking secrets.
 */
export async function GET() {
  const startedAt = Date.now()
  let dbOk = false

  try {
    // Minimal query that exercises DB connectivity without scanning big tables.
    await prisma.$queryRaw`SELECT 1`
    dbOk = true
  } catch (error) {
    console.error('Health check DB error:', error)
  }

  return NextResponse.json({
    ok: dbOk,
    db: dbOk ? 'ok' : 'error',
    time: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  })
}

