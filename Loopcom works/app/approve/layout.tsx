import type { CSSProperties, ReactNode } from 'react'

const scrollStyle: CSSProperties = {
  // Better behavior on mobile where 100vh can be taller than the visible viewport.
  height: '100dvh',
  // Enable momentum scrolling on iOS.
  WebkitOverflowScrolling: 'touch',
}

export default function ApproveLayout({ children }: { children: ReactNode }) {
  // The app disables body scrolling globally (see `app/globals.css`) and relies on route-level
  // scroll containers. Public approval pages should scroll naturally, so we provide one here.
  return (
    <div
      className="overflow-y-auto overscroll-y-contain bg-gray-100 pb-[env(safe-area-inset-bottom)]"
      style={scrollStyle}
    >
      {children}
    </div>
  )
}

