#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function parseDotEnv(content) {
  const out = {}
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    out[key] = value
  }
  return out
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function fail(message) {
  console.error(`ENV LOCKDOWN CHECK FAILED: ${message}`)
  process.exit(1)
}

const args = new Set(process.argv.slice(2))
const initIfMissing = args.has('--init-lock-if-missing')
const allowRotation = args.has('--allow-rotation') || String(process.env.ALLOW_ENV_KEY_ROTATION || '') === '1'

const envPath = path.resolve(process.cwd(), '.env')
const lockPath = path.resolve(process.cwd(), '.env.integrity.lock.json')

if (!fs.existsSync(envPath)) fail('.env is missing')

const env = parseDotEnv(fs.readFileSync(envPath, 'utf8'))

const keyMaterialCandidates = [
  'TOKEN_ENC_KEY',
  'ENCRYPTION_KEY',
  'NEXTAUTH_SECRET',
  'JWT_SECRET',
  'AUTH_SECRET',
  'SESSION_SECRET',
]

const hasKeyMaterial = keyMaterialCandidates.some((k) => String(env[k] || '').trim().length > 0)
if (!hasKeyMaterial) {
  fail('No encryption key material found (TOKEN_ENC_KEY / ENCRYPTION_KEY / NEXTAUTH_SECRET / JWT_SECRET / AUTH_SECRET / SESSION_SECRET)')
}

if (!String(env.DATABASE_URL || '').trim()) {
  fail('DATABASE_URL is missing')
}

const lockedKeys = [
  'TOKEN_ENC_KEY',
  'ENCRYPTION_KEY',
  'NEXTAUTH_SECRET',
  'JWT_SECRET',
  'AUTH_SECRET',
  'SESSION_SECRET',
  'DATABASE_URL',
]

const fingerprint = {}
for (const key of lockedKeys) {
  const val = String(env[key] || '')
  fingerprint[key] = val ? sha256(val) : null
}

if (!fs.existsSync(lockPath)) {
  if (!initIfMissing) {
    fail('.env.integrity.lock.json is missing. Run with --init-lock-if-missing once on trusted env.')
  }
  const payload = {
    createdAt: new Date().toISOString(),
    lockedKeys,
    fingerprint,
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log('ENV LOCKDOWN CHECK OK: created new .env.integrity.lock.json')
  process.exit(0)
}

let existing = null
try {
  existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
} catch {
  fail('.env.integrity.lock.json is invalid JSON')
}

const changed = []
for (const key of lockedKeys) {
  const prev = Object.prototype.hasOwnProperty.call(existing?.fingerprint || {}, key)
    ? existing.fingerprint[key]
    : null
  const next = Object.prototype.hasOwnProperty.call(fingerprint, key) ? fingerprint[key] : null
  if (prev !== next) changed.push(key)
}

if (changed.length > 0 && !allowRotation) {
  fail(`locked env keys changed: ${changed.join(', ')}. If intentional, rerun with --allow-rotation and rotate secrets safely.`)
}

if (changed.length > 0 && allowRotation) {
  const payload = {
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lockedKeys,
    fingerprint,
  }
  fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`ENV LOCKDOWN CHECK OK: updated lock after intentional rotation (${changed.join(', ')})`)
  process.exit(0)
}

console.log('ENV LOCKDOWN CHECK OK')
