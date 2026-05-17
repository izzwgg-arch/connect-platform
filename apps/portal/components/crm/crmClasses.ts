/**
 * Phase 19A — shared Tailwind class strings mapped to portal dark theme tokens.
 * Use these instead of gray-50 / bg-white so CRM pages match Workspace shell.
 */
export const crm = {
  page: "crm-page-shell",
  pageInner: "mx-auto w-full max-w-6xl px-4 py-6 flex flex-col gap-4",
  /** Phase 19B — dashboard command center uses full workspace width. */
  pageInnerWide: "mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 flex flex-col gap-5",
  /** Phase 19D — contact relationship workspace */
  pageInnerContact:
    "mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8 flex flex-col gap-4 min-h-0",
  /** Phase 19D.1 — contacts index relationship command center */
  pageInnerContacts:
    "mx-auto w-full max-w-[min(100%,1400px)] px-4 py-5 sm:px-6 lg:px-8 flex flex-col gap-4 min-h-0",
  /** Phase 19C / 19C.1 — My Queue operational workbench (wide desk, 12-col). */
  pageInnerQueue:
    "mx-auto w-full max-w-[min(100%,1680px)] px-3 py-5 sm:px-5 lg:px-6 xl:px-7 2xl:px-8 flex flex-col gap-4 min-h-0",
  /** Phase 19E / 19E.1 — campaign command center (wide desk, compact rhythm) */
  pageInnerCampaign:
    "mx-auto w-full max-w-[min(100%,1680px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-3 min-h-0",
  /** Phase 19E.1 — dense campaign index / member rows */
  campaignCard:
    "rounded-crm-lg border border-crm-border bg-crm-surface shadow-crm transition-colors hover:border-crm-border/90",
  campaignCardActive: "border-crm-accent/40 ring-1 ring-crm-accent/20",
  campaignCardPaused: "border-crm-warning/30",
  campaignCardDraft: "border-crm-border/80 border-dashed",
  campaignStatusStrip: "w-1 shrink-0 rounded-l-crm-lg",
  campaignPriorityPill:
    "px-2.5 py-1 text-xs font-medium rounded-crm border border-crm-border bg-crm-surface-2 text-crm-muted hover:bg-crm-surface transition-colors",
  campaignPriorityPillActive: "border-crm-accent/45 bg-crm-accent/12 text-crm-accent",
  campaignPriorityPillUrgent: "border-crm-danger/40 bg-crm-danger/12 text-crm-danger",
  campaignPriorityPillHigh: "border-crm-warning/40 bg-crm-warning/12 text-crm-warning",
  campaignModalBackdrop: "fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]",
  campaignGuidedEmpty:
    "rounded-crm border border-dashed border-crm-border/80 bg-crm-surface-2/40 px-4 py-5 sm:px-5",
  /** Phase 19F — live call agent workspace */
  pageInnerLive:
    "mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 flex flex-col gap-4 min-h-0",

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

  /** Phase 19C.1 — queue filter count pills (always dark surface). */
  queueCountPill:
    "flex min-w-[4.75rem] flex-col items-start rounded-crm border border-crm-border bg-crm-surface-2/90 px-3 py-2.5 text-left transition-all hover:border-crm-border/90 hover:bg-crm-surface",
  queueCountPillActive:
    "border-crm-accent/45 bg-crm-accent/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-crm-accent/25",
  queueCountPillUrgent: "border-crm-danger/35 bg-crm-danger/8",

  bannerSuccess: "border border-crm-success/35 bg-crm-success/10 text-crm-success",
  bannerWarning: "border border-crm-warning/35 bg-crm-warning/10 text-crm-warning",
  bannerDanger: "border border-crm-danger/35 bg-crm-danger/10 text-crm-danger",

  btnCallSuccess:
    "flex w-full items-center justify-center gap-3 rounded-crm bg-crm-success px-6 py-4 text-lg font-bold text-white shadow-crm hover:brightness-110 disabled:cursor-not-allowed disabled:bg-crm-surface-2 disabled:text-crm-muted/80 disabled:shadow-none",

  statValue: "font-semibold tabular-nums text-crm-text",
  statLabel: "text-crm-muted",

  emptyWrap: "rounded-crm-lg border border-dashed border-crm-border bg-crm-surface/60 px-6 py-12 text-center",
  emptyTitle: "text-base font-medium text-crm-text",
  emptyBody: "mt-2 text-sm text-crm-muted max-w-md mx-auto",

  divider: "border-t border-crm-border/60",
} as const;
