import { cn } from '@/lib/utils'

interface TrimProMarkProps {
  className?: string
  size?: number
  showWordmark?: boolean
}

export function TrimProMark({ className, size = 22, showWordmark = true }: TrimProMarkProps) {
  return (
    <div className={cn('inline-flex items-center gap-2 leading-none', className)}>
      <img
        src="/branding/trimpro-icon.svg"
        alt="TrimPro"
        width={size}
        height={size}
        className="block"
        style={{ width: size, height: size, objectFit: 'contain' }}
      />
      {showWordmark && (
        <span className="text-[26px] font-semibold tracking-normal">
          TrimPro
        </span>
      )}
    </div>
  )
}
