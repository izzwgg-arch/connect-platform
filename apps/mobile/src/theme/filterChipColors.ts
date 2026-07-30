import type { AppColors } from './colors';

/** Match Team tab `SummaryChip`: transparent + subtle border idle; tinted fill + accent border when active. */
export function teamFilterChipColors(active: boolean, accent: string, colors: AppColors) {
  if (!active) {
    return {
      backgroundColor: colors.transparent,
      // `border` (not `borderSubtle`): Izzy 2026-07-28 — idle chips need a
      // clearly visible pill outline, especially in dark mode.
      borderColor: colors.border,
    };
  }
  return {
    backgroundColor: `${accent}18`,
    borderColor: `${accent}38`,
  };
}
