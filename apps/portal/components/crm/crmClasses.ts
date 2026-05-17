/**
 * Phase 19A — shared Tailwind class strings mapped to portal dark theme tokens.
 * Use these instead of gray-50 / bg-white so CRM pages match Workspace shell.
 */
export const crm = {
  page: "crm-page-shell",
  pageInner: "mx-auto w-full max-w-6xl px-4 py-6 flex flex-col gap-4",

  card: "rounded-crm-lg border border-crm-border bg-crm-surface shadow-crm",
  cardPad: "p-5",
  cardPadLg: "p-6",
  cardHover: "transition-colors hover:border-crm-border/90",

  sectionGap: "flex flex-col gap-4",

  title: "text-xl font-semibold tracking-tight text-crm-text sm:text-2xl",
  subtitle: "mt-1 text-sm text-crm-muted leading-relaxed max-w-xl",
  label: "text-[0.6875rem] font-bold uppercase tracking-wider text-crm-muted",
  body: "text-sm text-crm-text",
  muted: "text-sm text-crm-muted",
  footnote: "text-[11px] leading-relaxed text-crm-muted",

  iconBox: "flex h-11 w-11 shrink-0 items-center justify-center rounded-crm bg-crm-accent/15 text-crm-accent",

  btnPrimary:
    "inline-flex items-center justify-center gap-2 rounded-crm bg-crm-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50",
  btnSecondary:
    "inline-flex items-center justify-center gap-2 rounded-crm border border-crm-border bg-crm-surface px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-surface-2 disabled:opacity-50",
  btnGhost:
    "inline-flex items-center justify-center gap-2 rounded-crm px-3 py-2 text-sm font-medium text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text disabled:opacity-50",
  btnDanger:
    "inline-flex items-center justify-center gap-2 rounded-crm border border-crm-danger/35 bg-crm-danger/10 px-3 py-2 text-sm font-medium text-crm-danger hover:bg-crm-danger/15 disabled:opacity-50",

  input:
    "w-full rounded-crm border border-crm-border bg-crm-surface-2/80 py-2.5 px-3 text-sm text-crm-text placeholder:text-crm-muted/70 focus:border-crm-accent/50 focus:bg-crm-surface focus:outline-none focus:ring-2 focus:ring-crm-accent/30",
  inputWithIcon: "pl-10 pr-10",

  chip:
    "inline-flex items-center gap-1 rounded-full border border-crm-border bg-crm-surface-2 px-2.5 py-0.5 text-xs font-medium text-crm-muted",
  chipActive: "border-crm-accent/40 bg-crm-accent/12 text-crm-accent",

  statValue: "font-semibold tabular-nums text-crm-text",
  statLabel: "text-crm-muted",

  emptyWrap: "rounded-crm-lg border border-dashed border-crm-border bg-crm-surface/60 px-6 py-12 text-center",
  emptyTitle: "text-base font-medium text-crm-text",
  emptyBody: "mt-2 text-sm text-crm-muted max-w-md mx-auto",

  divider: "border-t border-crm-border/60",
} as const;
