'use client'

import { ArrowLeft } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { smartBack } from '@/lib/navigation/nav-stack'

type Props = {
  /** Used when there is no return stack / history (deep link, new tab). */
  fallbackHref: string
  /** For edit/new pages: replace to this parent without consuming return stack. */
  parentHref?: string
  mode?: 'default' | 'parent'
  label?: string
  className?: string
  variant?: 'ghost' | 'outline' | 'link'
  size?: 'default' | 'sm' | 'lg' | 'icon'
}

/**
 * History-aware back control. Prefer stamped prior page (job/client/list);
 * never hard-wires to a list when the user arrived from somewhere else.
 */
export function EntityBackButton({
  fallbackHref,
  parentHref,
  mode = 'default',
  label = 'Back',
  className,
  variant = 'ghost',
  size = 'sm',
}: Props) {
  const router = useRouter()

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={() =>
        smartBack(router, {
          fallbackHref,
          parentHref,
          mode,
        })
      }
    >
      <ArrowLeft className="mr-2 h-4 w-4" />
      {label}
    </Button>
  )
}
