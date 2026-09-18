/**
 * Keep a highlighted dropdown row comfortably visible (not pinned to top/bottom edge).
 * Skips scrolling when the row already lies inside a padded band — reduces jitter.
 */
export function scrollPickerRowIntoComfortZone(
  rowElement: HTMLElement | null,
  scrollParent: HTMLElement | null,
  options?: { edgeMarginPx?: number }
): void {
  if (!rowElement || !scrollParent) return

  const margin = Math.max(8, options?.edgeMarginPx ?? 16)
  const row = rowElement.getBoundingClientRect()
  const port = scrollParent.getBoundingClientRect()

  const comfortableTop = port.top + margin
  const comfortableBottom = port.bottom - margin

  if (row.top >= comfortableTop && row.bottom <= comfortableBottom) {
    return
  }

  rowElement.scrollIntoView({
    block: 'center',
    inline: 'nearest',
    behavior: 'auto',
  })
}
