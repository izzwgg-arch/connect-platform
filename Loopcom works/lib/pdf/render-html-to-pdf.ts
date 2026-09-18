import puppeteer, { type Browser } from 'puppeteer'
import fs from 'fs'

let browserPromise: Promise<Browser> | null = null

/**
 * Resolve the Chrome executable path.
 *
 * Next.js bundles route handlers via webpack, which breaks puppeteer's normal
 * auto-detection of the downloaded Chrome binary (it can't walk the filesystem
 * from inside the bundle).  We work around this by:
 *   1. Trying puppeteer.executablePath() first (works in production / pm2).
 *   2. Falling back to PUPPETEER_EXECUTABLE_PATH env var (set in .env.local
 *      or system env for dev).
 *   3. Returning undefined so puppeteer can try its own fallback detection.
 */
function resolveChromePath(): string | undefined {
  // Env override — highest priority.
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH
  }
  try {
    const ep = puppeteer.executablePath()
    if (ep && fs.existsSync(ep)) return ep
  } catch {
    // Ignore — puppeteer.executablePath() may throw in some environments.
  }
  return undefined
}

function isBrowserConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  const name = error instanceof Error ? error.name : ''
  return (
    name === 'ConnectionClosedError' ||
    /connection closed/i.test(message) ||
    /browser has disconnected/i.test(message) ||
    /target closed/i.test(message) ||
    /session closed/i.test(message) ||
    /protocol error.*closed/i.test(message)
  )
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = resolveChromePath()
  const browser = await puppeteer.launch({
    executablePath,
    // Required on many Linux hosts (incl. Docker/VPS) unless Chromium sandbox is configured.
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  browser.on('disconnected', () => {
    browserPromise = null
  })

  return browser
}

async function resetBrowser(): Promise<void> {
  const current = browserPromise
  browserPromise = null

  if (!current) return

  try {
    const browser = await current
    if (browser.connected) {
      await browser.close().catch(() => {})
    }
  } catch {
    // Ignore cleanup errors for a dead browser instance.
  }
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const browser = await browserPromise
      if (browser.connected) {
        return browser
      }
      browserPromise = null
    } catch {
      browserPromise = null
    }
  }

  browserPromise = launchBrowser()
  return browserPromise
}

async function renderPdfOnce(
  html: string,
  options?: { waitUntil?: 'load' | 'networkidle0' | 'domcontentloaded' }
): Promise<Buffer> {
  const browser = await getBrowser()
  const page = await browser.newPage()

  const waitUntil =
    options?.waitUntil === 'load' || options?.waitUntil === 'domcontentloaded'
      ? options.waitUntil
      : (['load', 'networkidle0'] as const)

  try {
    await page.setContent(html, { waitUntil })

    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: '0.5in',
        right: '0.5in',
        bottom: '0.5in',
        left: '0.5in',
      },
    })

    return Buffer.from(pdf)
  } finally {
    await page.close().catch(() => {})
  }
}

export async function renderPdfFromHtml(
  html: string,
  options?: { waitUntil?: 'load' | 'networkidle0' | 'domcontentloaded' }
): Promise<Buffer> {
  try {
    return await renderPdfOnce(html, options)
  } catch (error) {
    if (!isBrowserConnectionError(error)) {
      throw error
    }

    await resetBrowser()
    return renderPdfOnce(html, options)
  }
}
