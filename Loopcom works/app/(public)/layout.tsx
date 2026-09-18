import Link from 'next/link'
import { TrimProLogo } from '@/components/branding/TrimProLogo'

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    // Dashboard uses its own scroll container (main overflow-y-auto). Our root layout
    // sets body height; to ensure public legal pages always scroll, we make this route
    // group its own scroll container.
    <div className="flex h-screen flex-col overflow-y-auto bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <Link href="/" className="inline-flex items-center">
            <div className="inline-flex items-center rounded-md bg-[#2E4A59] px-3 py-2">
              <TrimProLogo variant="light" size="md" />
            </div>
          </Link>
          <Link
            href="/auth/login"
            className="text-sm font-medium text-[#2E4A59] hover:underline"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10">{children}</main>

      <footer className="border-t bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground">
          <div>© {new Date().getFullYear()} TrimPro</div>
          <div className="flex items-center gap-4">
            <Link href="/download" className="hover:underline">
              Download App
            </Link>
            <Link href="/privacy" className="hover:underline">
              Privacy Policy
            </Link>
            <Link href="/terms" className="hover:underline">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

