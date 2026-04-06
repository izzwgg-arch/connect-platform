export const darkColors = {
  bg: '#090e18',
  bgSecondary: '#0d1426',
  surface: '#111827',
  surfaceElevated: '#162034',
  surfaceHigh: '#1c2840',
  overlay: 'rgba(9, 14, 24, 0.92)',

  border: '#1e2d47',
  borderLight: '#253555',
  borderSubtle: '#162036',

  text: '#f0f4ff',
  textSecondary: '#8899bb',
  textTertiary: '#4d6088',
  textMuted: '#2e4068',

  primary: '#3b82f6',
  primaryMuted: 'rgba(59, 130, 246, 0.12)',
  primaryGlow: 'rgba(59, 130, 246, 0.25)',
  primaryDim: 'rgba(59, 130, 246, 0.08)',

  teal: '#06b6d4',
  tealMuted: 'rgba(6, 182, 212, 0.12)',
  purple: '#a78bfa',
  purpleMuted: 'rgba(167, 139, 250, 0.12)',
  indigo: '#6366f1',
  indigoMuted: 'rgba(99, 102, 241, 0.12)',

  success: '#10b981',
  successMuted: 'rgba(16, 185, 129, 0.12)',
  successText: '#34d399',
  danger: '#f43f5e',
  dangerMuted: 'rgba(244, 63, 94, 0.12)',
  dangerText: '#fb7185',
  warning: '#f59e0b',
  warningMuted: 'rgba(245, 158, 11, 0.12)',
  warningText: '#fbbf24',

  callGreen: '#22c55e',
  callGreenGlow: 'rgba(34, 197, 94, 0.3)',
  callRed: '#ef4444',
  callRedGlow: 'rgba(239, 68, 68, 0.3)',

  presenceOnline: '#22c55e',
  presenceBusy: '#ef4444',
  presenceDnd: '#f97316',
  presenceAway: '#f59e0b',
  presenceOffline: '#475569',
  presenceOnCall: '#a78bfa',

  tabBar: '#090e18',
  tabBarBorder: '#162036',
  tabActive: '#3b82f6',
  tabInactive: '#374869',
  tabActiveGlow: 'rgba(59, 130, 246, 0.15)',

  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const;

export const lightColors = {
  bg: '#f0f4f9',
  bgSecondary: '#e8eef5',
  surface: '#ffffff',
  surfaceElevated: '#fafbfd',
  surfaceHigh: '#f8fafc',
  overlay: 'rgba(15, 23, 42, 0.6)',

  border: '#e2e8f0',
  borderLight: '#f0f4f8',
  borderSubtle: '#edf2f7',

  text: '#0f172a',
  textSecondary: '#475569',
  textTertiary: '#94a3b8',
  textMuted: '#cbd5e1',

  primary: '#2563eb',
  primaryMuted: 'rgba(37, 99, 235, 0.08)',
  primaryGlow: 'rgba(37, 99, 235, 0.18)',
  primaryDim: 'rgba(37, 99, 235, 0.05)',

  teal: '#0891b2',
  tealMuted: 'rgba(8, 145, 178, 0.08)',
  purple: '#7c3aed',
  purpleMuted: 'rgba(124, 58, 237, 0.08)',
  indigo: '#4f46e5',
  indigoMuted: 'rgba(79, 70, 229, 0.08)',

  success: '#059669',
  successMuted: 'rgba(5, 150, 105, 0.08)',
  successText: '#047857',
  danger: '#e11d48',
  dangerMuted: 'rgba(225, 29, 72, 0.08)',
  dangerText: '#be123c',
  warning: '#d97706',
  warningMuted: 'rgba(217, 119, 6, 0.08)',
  warningText: '#b45309',

  callGreen: '#16a34a',
  callGreenGlow: 'rgba(22, 163, 74, 0.25)',
  callRed: '#dc2626',
  callRedGlow: 'rgba(220, 38, 38, 0.25)',

  presenceOnline: '#16a34a',
  presenceBusy: '#dc2626',
  presenceDnd: '#ea580c',
  presenceAway: '#d97706',
  presenceOffline: '#94a3b8',
  presenceOnCall: '#7c3aed',

  tabBar: '#ffffff',
  tabBarBorder: '#e2e8f0',
  tabActive: '#2563eb',
  tabInactive: '#94a3b8',
  tabActiveGlow: 'rgba(37, 99, 235, 0.08)',

  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const;

export type AppColors = {
  [K in keyof typeof darkColors]: string;
};
