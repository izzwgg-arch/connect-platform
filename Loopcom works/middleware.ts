import { NextRequest, NextResponse } from 'next/server'

// Public customer links should always resolve on the public HTTPS domain.
// Some email clients will open old/stale links pointing at the server IP/port;
// this redirect keeps those links working without changing any auth logic.
export function middleware(request: NextRequest) {
  const host = String(request.headers.get('host') || '').toLowerCase()

  // Only redirect known "bad" hosts in production.
  if (process.env.NODE_ENV === 'production') {
    const [hostname, port] = host.split(':')
    const isIpHost = hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
    // Safety: if someone hit the node port directly from email (common old links).
    const isDirectNodePort = port === '3000'

    if (isIpHost || isDirectNodePort) {
      const url = request.nextUrl.clone()
      url.protocol = 'https:'
      url.hostname = 'app.trimprony.com' // trimprony.com is the actual production domain
      // Ensure we don't carry over a direct-node port (e.g., :3000) into the public URL.
      url.port = ''
      return NextResponse.redirect(url, 308)
    }
  }

  return NextResponse.next()
}

export const config = {
  // Redirect only triggers for IP/localhost/:3000 hosts, but we match broadly so old invoice/portal links
  // also get corrected to the canonical HTTPS domain. Excludes /api/ — this is only meant to fix stale
  // customer-facing PAGE links from old emails; applying it to API routes breaks legitimate server-to-server
  // calls over the internal loopback (the redirect strips the Authorization header on the cross-origin hop).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
}

