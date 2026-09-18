import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { AppProviders } from './providers'

const inter = Inter({ subsets: ['latin'] })

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#2e4a59',
  interactiveWidget: 'resizes-content',
}

export const metadata: Metadata = {
  title: 'Trim Pro - Field Service Management',
  description: 'Production-ready FSM platform for millwork/trim/molding companies',
  manifest: '/manifest.webmanifest',
  applicationName: 'Trim Pro',
  appleWebApp: {
    capable: true,
    title: 'Trim Pro',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/favicon-tp.svg',
    shortcut: '/favicon-tp.svg',
    apple: '/branding/trimpro-icon.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full bg-gray-100">
      <body className={`${inter.className} h-full bg-gray-100`}>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  )
}
