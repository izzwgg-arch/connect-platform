export { darkColors, lightColors } from './colors';
export type { AppColors } from './colors';
export { typography } from './typography';
export type { TypographyKey } from './typography';
export { spacing, radius, shadow } from './spacing';

// Legacy compat re-export (used by existing screens being phased out)
import { darkColors } from './colors';
export const colors = {
  bg: darkColors.bg,
  panel: darkColors.surface,
  topbar: '#0d1426',
  border: darkColors.border,
  text: darkColors.text,
  subText: darkColors.textSecondary,
  primary: darkColors.primary,
  danger: darkColors.danger,
  ok: darkColors.success,
};

export { colors as ui } from './legacyUi';
