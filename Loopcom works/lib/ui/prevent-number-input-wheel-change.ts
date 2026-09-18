import type { WheelEvent } from 'react'

/** Prevent mouse wheel from incrementing/decrementing focused number inputs; scroll instead. */
export function handleNumberInputWheel(e: WheelEvent<HTMLInputElement>) {
  if (document.activeElement !== e.currentTarget) return
  e.preventDefault()

  let node: HTMLElement | null = e.currentTarget.parentElement
  while (node) {
    const { overflowY } = getComputedStyle(node)
    const scrollable =
      (overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight
    if (scrollable) {
      node.scrollTop += e.deltaY
      return
    }
    node = node.parentElement
  }

  window.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' })
}
