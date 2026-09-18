import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

function fail(message) {
  console.error(`\n[release-guard] ${message}\n`)
  process.exit(1)
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    ...opts,
  })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`)
  }
  return result.stdout.trim()
}

function parseJson(relativeFile) {
  const absolute = path.resolve(process.cwd(), relativeFile)
  const raw = readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

function getCommitHash() {
  try {
    return run('git', ['rev-parse', '--short', 'HEAD'])
  } catch {
    return 'unknown'
  }
}

function assertCleanGit() {
  const unstaged = spawnSync('git', ['diff', '--quiet'], { stdio: 'ignore' })
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { stdio: 'ignore' })
  if (unstaged.status !== 0 || staged.status !== 0) {
    fail('Tracked changes detected. Commit or stash tracked changes before publishing OTA.')
  }
}

function validateConfig(targetChannel) {
  const eas = parseJson('eas.json')
  const app = parseJson('app.json')
  const profileKey = targetChannel === 'preview' ? 'preview' : 'production'

  const configuredChannel = eas?.build?.[profileKey]?.channel
  if (configuredChannel !== targetChannel) {
    fail(`eas.json build.${profileKey}.channel is "${configuredChannel}" but expected "${targetChannel}".`)
  }

  if (eas?.cli?.appVersionSource !== 'local') {
    fail('eas.json cli.appVersionSource must be "local".')
  }

  const runtimePolicy = app?.expo?.runtimeVersion?.policy
  if (runtimePolicy !== 'appVersion') {
    fail('app.json expo.runtimeVersion.policy must be "appVersion".')
  }

  if (!app?.expo?.updates?.url) {
    fail('app.json expo.updates.url is missing.')
  }
}

function buildMessage(inputMessage, commitHash) {
  const base = String(inputMessage || '').trim()
  if (!base) fail('Missing message. Usage: npm run ota:preview -- "your message"')
  return `${base} [${commitHash}]`
}

function main() {
  const [, , channelArg, ...rest] = process.argv
  const channel = String(channelArg || '').trim()
  if (channel !== 'preview' && channel !== 'production') {
    fail('Channel must be "preview" or "production".')
  }

  const dryRun = rest.includes('--dry-run')
  const messageParts = rest.filter((part) => part !== '--dry-run')
  const rawMessage = messageParts.join(' ').trim()
  const commitHash = getCommitHash()
  const message = buildMessage(rawMessage, commitHash)

  validateConfig(channel)
  assertCleanGit()

  if (dryRun) {
    console.log(`[release-guard] Dry run OK`)
    console.log(`[release-guard] Channel: ${channel}`)
    console.log(`[release-guard] Message: ${message}`)
    return
  }

  const env = { ...process.env, CI: '1' }
  // Windows + shell:true concatenates args; quote message so spaces stay one flag value.
  const quotedMessage = `"${String(message).replace(/"/g, '\\"')}"`
  const args = [
    'eas-cli',
    'update',
    '--channel',
    channel,
    '--message',
    quotedMessage,
    '--clear-cache',
  ]
  const result = spawnSync('npx', args, { stdio: 'inherit', env, shell: true })
  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

main()
