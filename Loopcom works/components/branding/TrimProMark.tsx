import { cn } from '@/lib/utils'

interface TrimProMarkProps {
  className?: string
  size?: number
  showWordmark?: boolean
}

/**
 * Server-safe mark + name (used by public/unauthenticated layouts that cannot
 * read the branding context). Renders the Loopcom square mark and, when asked,
 * the wordmark image with the "Works" tag — never text spelling the brand.
 */
export function TrimProMark({ className, size = 22, showWordmark = true }: TrimProMarkProps) {
  return (
    <div className={cn('inline-flex items-center gap-2 leading-none', className)}>
      {showWordmark ? (
        <>
          <img
            src="/brand/loopcom-wordmark-560.png"
            alt="Loopcom"
            width={560}
            height={99}
            className="block w-auto"
            style={{ height: Math.round(size * 1.1), width: 'auto' }}
          />
          <span className="lw-works-tag">Works</span>
        </>
      ) : (
        <img
          src="/brand/loopcom-icon-64.png"
          alt="Loopcom"
          width={size}
          height={size}
          className="block"
          style={{ width: size, height: size, objectFit: 'contain' }}
        />
      )}
    </div>
  )
}
