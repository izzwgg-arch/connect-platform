import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { AppProviders } from './providers'

const inter = Inter({ subsets: ['latin'], display: 'swap' })

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f8fb' },
    { media: '(prefers-color-scheme: dark)', color: '#0c1218' },
  ],
  interactiveWidget: 'resizes-content',
}

export const metadata: Metadata = {
  title: 'LoopCom Works',
  description: 'Jobs, estimates, invoices, purchase orders and scheduling for field-service businesses — by Loopcom.',
  manifest: '/manifest.webmanifest',
  applicationName: 'LoopCom Works',
  appleWebApp: {
    capable: true,
    title: 'LoopCom Works',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/brand/favicon-32.png', type: 'image/png', sizes: '32x32' },
      { url: '/brand/favicon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    shortcut: '/favicon.ico',
    apple: '/brand/favicon-180.png',
  },
  openGraph: {
    title: 'LoopCom Works',
    description: 'Jobs, estimates, invoices, purchase orders and scheduling for field-service businesses — by Loopcom.',
    siteName: 'LoopCom Works',
    images: [{ url: '/brand/favicon-512.png', width: 512, height: 512 }],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className={`${inter.className} h-full`}>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  )
}
