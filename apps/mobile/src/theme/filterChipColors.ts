import type { AppColors } from './colors';

/** Match Team tab `SummaryChip`: transparent + subtle border idle; tinted fill + accent border when active. */
export function teamFilterChipColors(active: boolean, accent: string, colors: AppColors) {
  if (!active) {
    return {
      backgroundColor: colors.transparent,
      borderColor: colors.borderSubtle,
    };
  }
  return {
    backgroundColor: `${accent}18`,
    borderColor: `${accent}38`,
  };
}
