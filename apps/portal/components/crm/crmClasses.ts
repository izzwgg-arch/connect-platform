/**
 * Phase 19A — shared Tailwind class strings mapped to portal dark theme tokens.
 * Use these instead of gray-50 / bg-white so CRM pages match Workspace shell.
 */
export const crm = {
  page: "crm-page-shell",
  pageInner: "mx-auto w-full max-w-6xl px-4 py-6 flex flex-col gap-4",
  /** Phase 19B — dashboard command center uses full workspace width. */
  pageInnerWide: "mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 flex flex-col gap-5",
  /** CRM dashboard light-mode workspace; dark mode continues using standard CRM tokens. */
  dashboardWorkspace: "crm-dashboard-workspace w-full min-h-0",
  pageInnerDashboard:
    "crm-dashboard-inner mx-auto w-full max-w-[1480px] px-3 py-5 sm:px-5 lg:px-6 xl:px-7 2xl:px-8 flex flex-col gap-4 min-h-0",
  /** Phase 19D — contact relationship workspace */
  pageInnerContact:
    "mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8 flex flex-col gap-4 min-h-0",
  /** Phase 19D.1 — contacts index relationship command center */
  pageInnerContacts:
    "crm-contacts-inner mx-auto w-full max-w-[min(100%,1680px)] px-3 py-5 sm:px-5 lg:px-6 xl:px-7 2xl:px-8 flex flex-col gap-4 min-h-0",
  /** Phase 19C / 19C.1 — My Queue operational workbench (wide desk, 12-col). */
  pageInnerQueue:
    "crm-queue-inner mx-auto w-full max-w-[min(100%,1680px)] px-3 py-5 sm:px-5 lg:px-6 xl:px-7 2xl:px-8 flex flex-col gap-4 min-h-0",
  /** CRM queue light-mode workspace; dark mode keeps existing queue token surfaces. */
  queueWorkspace: "crm-queue-workspace w-full min-h-0",
  /** CRM Email light-mode operations workspace. */
  pageInnerEmail:
    "crm-email-inner mx-auto w-full max-w-[min(100%,1365px)] px-3 py-5 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-4 min-h-0",
  emailWorkspace: "crm-email-workspace w-full min-h-0",
  emailHero: "crm-email-hero rounded-crm-lg border border-crm-border bg-crm-surface p-4 shadow-crm sm:p-5",
  emailPanel: "crm-email-panel relative overflow-hidden rounded-crm-lg border border-crm-border bg-crm-surface shadow-crm",
  emailIconWell: "crm-email-icon-well flex shrink-0 items-center justify-center rounded-crm border",
  emailKpiCard:
    "crm-email-kpi-card relative min-h-[7rem] overflow-hidden rounded-crm-lg border border-crm-border bg-crm-surface p-4 shadow-crm",
  /** Phase 19E / 19E.1 — campaign command center (wide desk, compact rhythm) */
  pageInnerCampaign:
    "mx-auto w-full max-w-[min(100%,1680px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-3 min-h-0",
  /** Forces dark CRM tokens even when portal data-theme=light (campaign routes only). */
  campaignWorkspace:
    "crm-campaign-workspace [color-scheme:dark] [--panel:#141f2b] [--panel-2:#1a2635] [--bg-soft:#101923] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#141f2b] [--crm-surface-2:#1a2635] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a]",
  /** Phase 19D.2+ — contacts index; theme tokens via globals `.crm-contacts-workspace` */
  contactsWorkspace: "crm-contacts-workspace w-full min-h-0",
  contactsHeaderPanel: "contacts-header-panel",
  contactsPanel: "contacts-panel",
  contactsKpiTile: "contacts-kpi-tile relative flex min-h-[7.75rem] min-w-0 flex-col gap-2 overflow-hidden rounded-crm-lg border px-4 py-3.5 transition-all duration-200 sm:min-w-0",
  contactsKpiIcon: "contacts-kpi-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-crm",
  contactsFilterBar: "contacts-filter-bar",
  contactsBulkBar: "contacts-bulk-bar mb-4 flex flex-wrap items-center gap-3 rounded-crm border px-4 py-3",
  contactsListShell: "contacts-list-shell overflow-hidden p-0",
  contactsListSelectBar:
    "contacts-list-select-bar flex items-center gap-3 border-b px-4 py-2.5",
  contactsListRow: "contacts-list-row group px-4 py-4 transition-colors sm:px-5",
  contactsEmpty: "contacts-empty-wrap rounded-crm-lg border border-dashed px-6 py-14 text-center",
  contactsPagination: "contacts-pagination mt-6 flex flex-col items-stretch gap-3 rounded-crm-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
  contactsModalBackdrop: "contacts-modal-backdrop fixed inset-0 z-50 flex items-center justify-center px-4",
  contactsModalPanel: "contacts-modal-panel w-full max-w-md rounded-crm border p-6",
  /** Phase 19E.3 — detail page vertical stack (no skinny aside rail) */
  campaignDetailStack: "flex w-full min-w-0 flex-col gap-3",
  campaignDetailCommandGrid:
    "grid w-full min-w-0 grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4",
  campaignDetailBtnSecondary:
    "inline-flex items-center justify-center gap-1.5 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2 text-sm font-medium text-crm-text shadow-none hover:bg-crm-surface hover:border-crm-border/90 disabled:cursor-not-allowed disabled:border-crm-border/70 disabled:bg-crm-surface-2/75 disabled:text-crm-muted/80 disabled:opacity-100",
  campaignDetailBtnTertiary:
    "inline-flex items-center justify-center gap-1 rounded-crm border border-crm-border/65 bg-crm-surface-2/50 px-2.5 py-1.5 text-xs font-medium text-crm-muted shadow-none hover:border-crm-border hover:bg-crm-surface-2 hover:text-crm-text disabled:cursor-not-allowed disabled:border-crm-border/55 disabled:bg-crm-surface-2/40 disabled:text-crm-muted/65 disabled:opacity-100",
  /** @deprecated 19E.3 — use campaignDetailStack + CampaignDetailCommandPanel */
  campaignDetailGrid: "grid gap-4 lg:grid-cols-12 lg:items-start",
  campaignMainCol: "lg:col-span-12 flex flex-col gap-3 min-w-0",
  campaignAsideCol: "hidden",
  /** Phase 19E.1 — dense campaign index / member rows */
  campaignCard:
    "rounded-crm-lg border border-crm-border bg-crm-surface shadow-crm transition-[border-color,box-shadow,transform] duration-200 hover:border-crm-border/90 hover:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.45)] hover:-translate-y-px",
  campaignCardActive:
    "crm-campaign-card-active border-crm-accent/45 ring-1 ring-crm-accent/25 shadow-[0_0_0_1px_rgba(56,189,248,0.08),0_0_28px_-6px_rgba(56,189,248,0.14)]",
  campaignCardQueueGlow:
    "shadow-[0_0_0_1px_rgba(56,189,248,0.12),0_0_32px_-8px_rgba(56,189,248,0.18)]",
  campaignCardPaused: "border-crm-warning/35 ring-1 ring-crm-warning/10",
  campaignCardDraft: "border-crm-border/80 border-dashed",
  campaignStatusStrip: "w-1 shrink-0 rounded-l-crm-lg",
  campaignStatusStripLive: "crm-campaign-status-strip-live w-1.5",
  /** Phase 19E.3 — grouped metric clusters on index cards */
  campaignMetricCluster:
    "rounded-crm border border-crm-border/70 bg-crm-surface-2/80 p-2 min-w-0 flex-1",
  campaignMetricClusterTitle:
    "text-[10px] font-semibold uppercase tracking-wider text-crm-muted/90 mb-1.5",
  campaignIndexMetric:
    "flex min-w-0 flex-col gap-0.5 border-t border-crm-border/50 pt-1.5 first:border-t-0 first:pt-0",
  campaignIndexMetricLabel: "text-[10px] font-medium leading-tight text-crm-muted",
  campaignIndexMetricValue: "text-lg font-semibold tabular-nums leading-none text-crm-text",
  campaignPressureLine: "text-[11px] font-medium leading-snug",
  campaignFilterBar:
    "border-crm-border/80 bg-crm-surface-2/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-sm",
  campaignCommandSticky: "sticky top-0 z-20 -mx-1 px-1 pb-1 pt-0.5",
  campaignBtnSecondaryCompact:
    "inline-flex items-center justify-center gap-1.5 rounded-crm border border-crm-border bg-crm-surface-2 px-2.5 py-1.5 text-xs font-medium text-crm-text hover:bg-crm-surface hover:border-crm-border/90",
  campaignBtnTertiary:
    "inline-flex items-center justify-center gap-1 rounded-crm border border-transparent bg-transparent px-2 py-1 text-[11px] font-medium text-crm-muted hover:border-crm-border/50 hover:bg-crm-surface-2/40 hover:text-crm-text",
  campaignSearchInput:
    "w-full rounded-crm border border-crm-border !bg-crm-surface-2 py-2 pl-10 pr-3 text-sm !text-crm-text shadow-none placeholder:text-crm-muted/70 focus:border-crm-accent/55 focus:!bg-crm-surface focus:outline-none focus:ring-2 focus:ring-crm-accent/35 [color-scheme:dark]",
  campaignPriorityPill:
    "px-2.5 py-1 text-xs font-medium rounded-crm border border-crm-border bg-crm-surface-2 text-crm-muted hover:bg-crm-surface transition-colors",
  campaignPriorityPillActive: "border-crm-accent/45 bg-crm-accent/12 text-crm-accent",
  campaignPriorityPillUrgent: "border-crm-danger/40 bg-crm-danger/12 text-crm-danger",
  campaignPriorityPillHigh: "border-crm-warning/40 bg-crm-warning/12 text-crm-warning",
  campaignModalBackdrop: "fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]",
  campaignGuidedEmpty:
    "rounded-crm border border-dashed border-crm-border/80 bg-crm-surface-2/50 px-4 py-4 sm:px-5",
  /** Phase 19E.4 — premium command-center surfaces */
  campaignCommandHero:
    "crm-campaign-command-hero relative overflow-hidden rounded-crm-lg border border-crm-border/80 bg-crm-surface shadow-[0_8px_40px_-12px_rgba(0,0,0,0.55)]",
  campaignCommandHeroInner: "relative z-[1] flex flex-col gap-4 p-4 sm:p-5 lg:p-6",
  campaignCommandHeroKpiGrid:
    "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-5",
  campaignCommandHeroKpi:
    "rounded-crm border border-crm-border/70 bg-crm-surface-2/60 px-3 py-2.5 backdrop-blur-sm transition-colors hover:border-crm-border/90",
  campaignCommandHeroKpiUrgent: "border-crm-warning/40 bg-crm-warning/8",
  campaignCommandHeroKpiAccent: "border-crm-accent/35 bg-crm-accent/8",
  campaignCommandHeroKpiValue: "text-2xl font-bold tabular-nums leading-none text-crm-text sm:text-[1.65rem]",
  campaignCommandHeroKpiLabel:
    "text-[10px] font-bold uppercase tracking-wider text-crm-muted",
  campaignIndexRowList: "m-0 flex list-none flex-col gap-1.5 p-0",
  campaignIndexRow:
    "crm-campaign-index-row group relative flex min-h-[4.75rem] w-full min-w-0 overflow-hidden rounded-crm-lg border border-crm-border/80 bg-crm-surface transition-[border-color,box-shadow,transform] duration-200 hover:border-crm-border hover:shadow-[0_8px_28px_-10px_rgba(0,0,0,0.5)] hover:-translate-y-px",
  campaignIndexRowActive:
    "crm-campaign-index-row-active border-crm-accent/50 shadow-[0_0_0_1px_rgba(56,189,248,0.1),0_0_36px_-8px_rgba(56,189,248,0.2)]",
  campaignIndexRowQueueGlow:
    "shadow-[0_0_0_1px_rgba(56,189,248,0.14),0_0_40px_-6px_rgba(56,189,248,0.22)]",
  campaignIndexRowPaused: "border-crm-warning/35",
  campaignIndexRowDraft: "border-dashed border-crm-border/70",
  campaignIndexRowMetric:
    "flex min-w-[4.25rem] flex-col gap-0.5 px-2 py-1 sm:min-w-[5rem] lg:px-3",
  campaignIndexRowMetricValue: "text-lg font-bold tabular-nums leading-none text-crm-text sm:text-xl",
  campaignIndexRowMetricLabel: "text-[10px] font-semibold uppercase tracking-wide text-crm-muted/90",
  campaignPerformanceSurface:
    "crm-campaign-performance-surface overflow-hidden rounded-crm-lg border border-crm-border/80 bg-crm-surface shadow-crm",
  campaignPerformanceSurfaceInner:
    "grid gap-0 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)_minmax(0,200px)] lg:divide-x lg:divide-crm-border/60",
  campaignPerformanceZone: "flex min-w-0 flex-col justify-center p-4 sm:p-5",
  campaignOpsCell:
    "flex min-h-[7.5rem] min-w-0 flex-col rounded-crm-lg border border-crm-border/75 bg-crm-surface-2/40 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-3.5",
  campaignOpsCellHeader: "mb-2 flex items-center justify-between gap-2",
  campaignOpsRow:
    "flex items-center justify-between gap-2 rounded-crm border border-crm-border/60 bg-crm-surface/80 px-2.5 py-2 text-xs",
  campaignRosterShell:
    "overflow-hidden rounded-crm-lg border border-crm-border/80 bg-crm-surface shadow-crm",
  campaignRosterToolbar:
    "flex flex-wrap items-center gap-2 border-b border-crm-border/70 bg-crm-surface-2/40 px-3 py-2.5 sm:px-4",
  campaignRosterTableHead:
    "hidden lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,0.75fr)_minmax(0,0.55fr)_minmax(0,0.55fr)_minmax(0,0.65fr)_auto] lg:gap-3 lg:border-b lg:border-crm-border/60 lg:bg-crm-surface-2/50 lg:px-4 lg:py-2 text-[10px] font-bold uppercase tracking-wider text-crm-muted",
  campaignRosterBody: "flex flex-col gap-1 p-2 sm:p-2.5",
  campaignMemberRow:
    "crm-campaign-member-row grid grid-cols-1 gap-2 rounded-crm border border-crm-border/70 bg-crm-surface-2/30 px-3 py-2.5 transition-colors hover:border-crm-border hover:bg-crm-surface-2/50 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,0.75fr)_minmax(0,0.55fr)_minmax(0,0.55fr)_minmax(0,0.65fr)_auto] lg:items-center lg:gap-3 lg:px-4 lg:py-2",
  campaignQuickStrip:
    "crm-campaign-quick-strip sticky bottom-0 z-30 mt-auto flex flex-wrap items-stretch gap-0 overflow-hidden rounded-crm-lg border border-crm-border/80 bg-crm-surface-2/90 shadow-[0_-8px_32px_-8px_rgba(0,0,0,0.45)] backdrop-blur-md",
  campaignQuickStripItem:
    "flex min-w-0 flex-1 flex-col justify-center gap-0.5 border-r border-crm-border/50 px-3 py-2.5 text-left transition-colors last:border-r-0 hover:bg-crm-accent/8 sm:px-4 sm:py-3",
  campaignQuickStripKbd:
    "inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-crm-border/80 bg-crm-surface px-1 text-[10px] font-bold text-crm-muted",
  campaignQuickStripLabel: "text-xs font-semibold text-crm-text sm:text-sm",
  campaignQuickStripHint: "text-[10px] leading-snug text-crm-muted",
  campaignDetailHeroKpiGrid:
    "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6",
  campaignDetailHeroKpi:
    "rounded-crm border border-crm-border/70 bg-crm-surface-2/50 px-2.5 py-2 sm:px-3 sm:py-2.5",
  campaignDetailHeroKpiValue: "text-xl font-bold tabular-nums text-crm-text sm:text-2xl",
  campaignSortSelect:
    "rounded-crm border border-crm-border bg-crm-surface-2 py-2 pl-3 pr-8 text-xs font-medium text-crm-text shadow-none focus:border-crm-accent/50 focus:outline-none focus:ring-2 focus:ring-crm-accent/30 [color-scheme:dark]",
  /** Phase 19F — live call agent workspace */
  pageInnerLive:
    "crm-live-inner mx-auto w-full max-w-[min(100%,1680px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 2xl:px-8 flex flex-col gap-4 min-h-0",
  liveWorkspace: "crm-live-workspace w-full min-h-0",
  /** Phase 19G — live wallboard; theme tokens via globals `.crm-wallboard-workspace` */
  wallboardWorkspace: "crm-wallboard-workspace w-full min-h-0",
  /** Phase 19K — CRM Intelligence reports; theme tokens via globals `.crm-reports-workspace` */
  reportsWorkspace: "crm-reports-workspace w-full min-h-0",
  pageInnerReports:
    "mx-auto w-full max-w-[min(100%,1680px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-4 min-h-0",
  reportsHeroGrid:
    "grid grid-cols-2 gap-3 lg:grid-cols-4",
  reportsGrid:
    "grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-start",
  reportsMainCol:
    "flex flex-col gap-4 min-w-0 lg:col-span-2",
  reportsSideCol:
    "flex flex-col gap-3 min-w-0",

  card: "rounded-crm-lg border border-crm-border bg-crm-surface shadow-crm",
  cardPad: "p-5",
  cardPadLg: "p-6",
  cardHover: "transition-colors hover:border-crm-border/90",
  opCard:
    "relative overflow-hidden rounded-crm-lg border border-crm-border/80 bg-crm-surface shadow-[0_10px_36px_-18px_rgba(0,0,0,0.65)]",
  opCardHover:
    "transition-[border-color,box-shadow,transform,background-color] duration-200 hover:-translate-y-px hover:border-crm-border hover:shadow-[0_16px_44px_-22px_rgba(0,0,0,0.7)]",
  opCardGlow:
    "pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_55%_at_0%_0%,rgba(56,189,248,0.08),transparent_55%),radial-gradient(ellipse_42%_35%_at_100%_0%,rgba(99,102,241,0.06),transparent_56%)]",
  opInset:
    "rounded-crm border border-crm-border/60 bg-crm-surface-2/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
  statusDot: "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
  statusDotLive: "inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-crm-success shadow-[0_0_0_3px_rgba(34,197,94,0.12)]",
  statusDotWarn: "inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-crm-warning shadow-[0_0_0_3px_rgba(245,158,11,0.10)]",
  statusDotDanger: "inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-crm-danger shadow-[0_0_0_3px_rgba(239,68,68,0.10)]",
  statusDotSync: "inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-crm-accent shadow-[0_0_0_3px_rgba(56,189,248,0.12)]",

  sectionGap: "flex flex-col gap-4",

  title: "text-xl font-semibold tracking-tight text-crm-text sm:text-2xl",
  subtitle: "mt-1 text-sm text-crm-muted leading-relaxed max-w-xl",
  label: "text-[0.6875rem] font-bold uppercase tracking-wider text-crm-muted",
  body: "text-sm text-crm-text",
  muted: "text-sm text-crm-muted",
  footnote: "text-[11px] leading-relaxed text-crm-muted",

  iconBox: "flex h-11 w-11 shrink-0 items-center justify-center rounded-crm bg-crm-accent/15 text-crm-accent",

  btnPrimary:
    "inline-flex items-center justify-center gap-2 rounded-crm border border-transparent bg-crm-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:border-crm-border disabled:bg-crm-surface-2 disabled:text-crm-muted disabled:opacity-100 disabled:shadow-none",
  btnSecondary:
    "inline-flex items-center justify-center gap-2 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2 text-sm font-medium text-crm-text hover:bg-crm-surface hover:border-crm-border/90 disabled:cursor-not-allowed disabled:bg-crm-surface-2/60 disabled:text-crm-muted/80 disabled:opacity-100",
  btnGhost:
    "inline-flex items-center justify-center gap-2 rounded-crm border border-transparent bg-crm-surface-2/50 px-3 py-2 text-sm font-medium text-crm-muted hover:border-crm-border/60 hover:bg-crm-surface-2 hover:text-crm-text disabled:cursor-not-allowed disabled:bg-crm-surface-2/40 disabled:text-crm-muted/70 disabled:opacity-100",
  btnDanger:
    "inline-flex items-center justify-center gap-2 rounded-crm border border-crm-danger/35 bg-crm-danger/10 px-3 py-2 text-sm font-medium text-crm-danger hover:bg-crm-danger/15 disabled:opacity-50",

  input:
    "w-full rounded-crm border border-crm-border !bg-crm-surface-2 py-2.5 px-3 text-sm !text-crm-text shadow-none placeholder:text-crm-muted/70 focus:border-crm-accent/50 focus:!bg-crm-surface focus:outline-none focus:ring-2 focus:ring-crm-accent/30 disabled:cursor-not-allowed disabled:opacity-70 disabled:!bg-crm-surface-2/60 [color-scheme:dark]",
  inputWithIcon: "pl-10 pr-10",
  select: "w-full rounded-crm border border-crm-border !bg-crm-surface-2 py-2.5 pl-3 pr-9 text-sm !text-crm-text shadow-none focus:border-crm-accent/50 focus:!bg-crm-surface focus:outline-none focus:ring-2 focus:ring-crm-accent/30 disabled:cursor-not-allowed disabled:opacity-70 [color-scheme:dark]",

  chip:
    "inline-flex items-center gap-1 rounded-full border border-crm-border bg-crm-surface-2 px-2.5 py-0.5 text-xs font-medium text-crm-muted",
  chipActive: "border-crm-accent/40 bg-crm-accent/12 text-crm-accent",

  /** Phase 19D.2 — contacts command bar filter pills (theme via workspace tokens) */
  filterPill:
    "contacts-filter-pill rounded-full border border-crm-border bg-crm-surface-2 px-3 py-1.5 text-xs font-medium text-crm-text transition-colors hover:border-crm-border/90 hover:bg-crm-surface",
  filterPillActive:
    "contacts-filter-pill-active rounded-full border border-crm-accent/50 bg-crm-accent px-3 py-1.5 text-xs font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
  filterPillGroup:
    "contacts-filter-pill-group inline-flex flex-wrap items-center gap-1.5 rounded-full border px-2 py-1",
  checkbox:
    "contacts-checkbox h-4 w-4 shrink-0 cursor-pointer rounded border border-crm-border bg-crm-surface-2 text-crm-accent accent-crm-accent focus:ring-2 focus:ring-crm-accent/30 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50",
  selectCompact:
    "contacts-select-compact rounded-crm border border-crm-border !bg-crm-surface-2 px-2 py-1.5 text-sm !text-crm-text shadow-none focus:border-crm-accent/50 focus:!bg-crm-surface focus:outline-none focus:ring-2 focus:ring-crm-accent/30 disabled:cursor-not-allowed disabled:opacity-70",

  /** Phase 19C.1 — queue filter count pills (always dark surface). */
  queueCountPill:
    "crm-queue-kpi-card flex h-full min-h-[6.25rem] w-full min-w-0 flex-col items-start justify-between rounded-crm-lg border border-crm-border bg-crm-surface-2 px-3.5 py-3 text-left transition-all duration-200 hover:border-crm-border/90 hover:bg-crm-surface",
  queueCountPillActive:
    "crm-queue-kpi-active border-crm-accent/45 bg-crm-accent/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-crm-accent/25",
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

  /** Queue command sidebar — consistent dark surfaces, even rhythm */
  sidebarCard: "border-crm-border bg-crm-surface shadow-crm",
  sidebarSection: "flex flex-col gap-2 py-0.5",
  metricTile:
    "flex flex-col justify-between rounded-crm border border-crm-border bg-crm-surface-2 px-2.5 py-2",

  /** Phase 19H — task command desk (wide, two-column) */
  pageInnerTasks:
    "mx-auto w-full max-w-[min(100%,1540px)] px-3 py-5 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-4 min-h-0",
  /** Phase 19H — task command desk; theme tokens via globals `.crm-tasks-workspace` */
  tasksWorkspace: "crm-tasks-workspace w-full min-h-0",
  tasksGrid: "grid gap-4 xl:grid-cols-12 xl:items-start",
  tasksMainCol: "xl:col-span-9 flex flex-col gap-3 min-w-0",
  tasksSideCol:
    "xl:col-span-3 flex flex-col gap-3 min-w-0 xl:min-w-[18rem]",

  /** Priority rail on task cards */
  taskRailLow: "w-1 shrink-0 rounded-l-crm-lg bg-crm-border/80",
  taskRailMedium: "w-1 shrink-0 rounded-l-crm-lg bg-crm-accent",
  taskRailHigh: "w-1 shrink-0 rounded-l-crm-lg bg-crm-warning",
  taskRailUrgent: "w-1 shrink-0 rounded-l-crm-lg bg-crm-danger",

  /** KPI strip tiles for task desk */
  taskKpiTile:
    "flex flex-col gap-1 rounded-crm-lg border border-crm-border bg-crm-surface px-4 py-3 min-h-[4.5rem] transition-colors hover:border-crm-border/90",
  taskKpiTileDanger: "border-crm-danger/40",
  taskKpiTileWarning: "border-crm-warning/35",
  taskKpiTileSuccess: "border-crm-success/35",

  /** Quick-add row */
  taskQuickAddRow:
    "flex items-center gap-2 rounded-crm-lg border border-dashed border-crm-border/80 bg-crm-surface-2/40 px-4 py-3 transition-colors hover:border-crm-border hover:bg-crm-surface-2/70",

  /** Tab pills (counts-aware) */
  taskTabPill:
    "inline-flex items-center gap-1.5 rounded-full border border-crm-border/70 bg-crm-surface-2/60 px-3 py-1.5 text-xs font-medium text-crm-muted transition-colors hover:border-crm-border hover:bg-crm-surface-2 hover:text-crm-text",
  taskTabPillActive:
    "inline-flex items-center gap-1.5 rounded-full border border-crm-accent/50 bg-crm-accent/12 px-3 py-1.5 text-xs font-medium text-crm-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
  taskTabPillDanger:
    "inline-flex items-center gap-1.5 rounded-full border border-crm-danger/40 bg-crm-danger/10 px-3 py-1.5 text-xs font-medium text-crm-danger",

  /** Phase 19J — checklist operational workspace */
  pageInnerChecklist:
    "relative mx-auto w-full max-w-[min(100%,1600px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-3 min-h-0 z-[1]",
  /** Phase 19J — checklist operational workspace; theme tokens via globals `.crm-checklist-workspace` */
  checklistWorkspace: "crm-checklist-workspace relative min-h-full w-full min-h-0",
  checklistAmbientLayer:
    "pointer-events-none absolute inset-0 z-0 overflow-hidden",
  checklistCommandHeader:
    "checklist-command-header relative z-[1] overflow-hidden rounded-2xl border border-crm-border/50",
  checklistCommandHeaderGlow:
    "checklist-command-header-glow pointer-events-none absolute inset-0",
  checklistCommandIcon:
    "checklist-command-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-crm-accent/40 text-crm-accent",
  checklistKpiTile:
    "checklist-kpi-tile rounded-xl border px-3 py-2.5 backdrop-blur-sm transition-all duration-300 hover:-translate-y-px",
  checklistTab:
    "checklist-tab rounded-lg px-3.5 py-1.5 text-xs font-medium text-crm-muted transition-all",
  checklistTabActive:
    "checklist-tab checklist-tab-active rounded-lg px-3.5 py-1.5 text-xs font-semibold text-crm-accent",
  checklistTipsStrip:
    "checklist-tips-strip relative z-[1] overflow-hidden rounded-2xl border border-crm-border/35 px-3 py-2.5",
  checklistTipSegment:
    "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-transparent px-2.5 py-2 transition-all hover:border-crm-accent/20 hover:bg-crm-accent/[0.06]",
  checklistCinematicHero:
    "checklist-cinematic-hero relative isolate min-h-[min(26rem,48vh)] overflow-hidden rounded-2xl border border-crm-accent/15",
  checklistCinematicHeroVignette:
    "checklist-cinematic-hero-vignette pointer-events-none absolute inset-0",
  checklistCinematicHeroGlowTop:
    "pointer-events-none absolute -left-1/4 -top-1/3 h-[70%] w-[150%] bg-[radial-gradient(ellipse_at_center,rgba(56,189,248,0.22),transparent_62%)]",
  checklistCinematicHeroGlowFloor:
    "pointer-events-none absolute -bottom-1/4 left-1/2 h-1/2 w-[120%] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(56,189,248,0.08),transparent_65%)]",
  checklistCinematicHeroGrid:
    "checklist-cinematic-hero-grid pointer-events-none absolute inset-0 opacity-[0.04] [background-size:28px_28px]",
  checklistOrbRingOuter:
    "pointer-events-none absolute -inset-8 rounded-full border border-crm-accent/10 bg-crm-accent/[0.03] checklist-orb-ring",
  checklistOrbRingMid:
    "pointer-events-none absolute -inset-4 rounded-full border border-crm-accent/20 bg-gradient-to-br from-crm-accent/10 to-transparent",
  checklistOnboardingOrb:
    "checklist-onboarding-orb relative z-[1] flex h-28 w-28 items-center justify-center rounded-full border border-crm-accent/35",
  checklistOnboardingOrbPulse:
    "pointer-events-none absolute inset-[-12px] rounded-full bg-crm-accent/12 checklist-orb-pulse",
  checklistCtaGlow:
    "shadow-[0_0_28px_-6px_rgba(56,189,248,0.45)] hover:shadow-[0_0_36px_-4px_rgba(56,189,248,0.55)]",
  checklistFeatureCard:
    "checklist-feature-card group relative flex flex-col gap-1.5 overflow-hidden rounded-xl border border-crm-border/40 px-3.5 py-3 transition-all duration-300",
  checklistGrid: "relative z-[1] grid gap-3 lg:grid-cols-12 lg:items-stretch",
  checklistLibraryCol:
    "lg:col-span-3 xl:col-span-3 flex flex-col min-w-0 opacity-[0.92] lg:pt-1",
  checklistWorkspaceCol:
    "lg:col-span-6 xl:col-span-6 flex flex-col min-w-0 min-h-[30rem] z-[2]",
  checklistSideCol:
    "lg:col-span-3 xl:col-span-3 flex flex-col min-w-0 opacity-[0.92] lg:pt-1",
  /** Quieter support column (library + progress) */
  checklistPanelSupport:
    "checklist-side-panel checklist-panel-support rounded-2xl border border-crm-border/30 backdrop-blur-md",
  /** Primary center workspace — cinematic hero elevation */
  checklistPanelPrimary:
    "checklist-panel-cinematic checklist-panel-primary relative overflow-hidden rounded-2xl border border-crm-accent/20",
  checklistPanelPrimaryGlow:
    "checklist-panel-primary-glow pointer-events-none absolute inset-0",
  checklistWorkspaceHeader:
    "border-b border-crm-border/50 bg-gradient-to-r from-crm-surface-2/40 via-transparent to-transparent px-4 py-3",
  checklistHeroBand:
    "checklist-hero-band relative overflow-hidden rounded-crm-lg border border-crm-border/50 px-4 py-4 sm:px-5",
  checklistHeroGlow:
    "pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-crm-accent/10 blur-2xl",
  /** Checklist card in library */
  checklistCard:
    "group relative flex items-stretch rounded-crm border border-crm-border/60 bg-crm-surface-2/40 transition-all duration-200 hover:border-crm-border/90 hover:bg-crm-surface-2/70 cursor-pointer checklist-card",
  checklistCardActive:
    "border-crm-accent/45 bg-crm-accent/10 ring-1 ring-crm-accent/25 shadow-[0_0_20px_-8px_rgba(56,189,248,0.2)]",
  checklistCardArchived: "opacity-50",
  checklistStatusStrip: "w-1 shrink-0 rounded-l-crm",
  /** Workflow step card in workspace */
  checklistStepCard:
    "flex w-full items-start gap-3 rounded-crm border px-3 py-2.5 text-left text-sm transition-all duration-200",
  checklistStepPending:
    "checklist-step-pending border-crm-border/60 text-crm-text",
  checklistStepRequired:
    "border-crm-warning/40 bg-gradient-to-r from-crm-warning/8 to-transparent text-crm-text shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_0_16px_-8px_rgba(245,158,11,0.15)]",
  checklistStepNum:
    "checklist-step-num flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crm-border/70 text-[11px] font-bold tabular-nums text-crm-muted",
  checklistStepNumRequired:
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crm-warning/50 bg-crm-warning/15 text-[11px] font-bold tabular-nums text-crm-warning shadow-[0_0_10px_-4px_rgba(245,158,11,0.35)]",
  /** Template card base (accent via TEMPLATE_ACCENT_CLASSES) */
  checklistTemplateCard:
    "checklist-template-card group relative w-full overflow-hidden rounded-2xl border text-left cursor-pointer",
  checklistTemplateCardInner:
    "relative z-[2] flex flex-col gap-3 p-4 sm:p-[1.125rem]",
  checklistTemplateStrip:
    "absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl opacity-90",
  checklistTemplateGlow:
    "pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100",
  checklistTemplateIconWrap:
    "relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-105",
  checklistTemplateIcon:
    "checklist-template-icon relative z-[1] flex h-10 w-10 items-center justify-center rounded-lg border text-lg",
  checklistTemplateBadge:
    "shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
  checklistMetricChip:
    "checklist-metric-chip inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium tabular-nums backdrop-blur-sm",
  checklistProgressCard:
    "checklist-side-panel checklist-progress-card rounded-2xl border border-crm-border/30 p-4 backdrop-blur-md",
  checklistInsetSurface:
    "checklist-inset-surface rounded-crm border border-crm-border/40",

  /** Phase 19I / 19I.1 / 19I.2 — scripts premium playbook (theme-aware via globals `.crm-scripts-workspace`) */
  pageInnerScripts:
    "mx-auto w-full max-w-[min(100%,1680px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 2xl:px-8 flex flex-col gap-4 min-h-0",
  scriptsWorkspace: "crm-scripts-workspace w-full min-h-0",
  scriptsHero:
    "scripts-command-hero relative overflow-hidden rounded-crm-lg border px-4 py-4 sm:px-5 sm:py-5",
  scriptsHeroGlow:
    "scripts-command-hero-glow pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full blur-3xl motion-reduce:hidden",
  scriptsHeroIcon:
    "scripts-command-hero-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-crm-lg border",
  scriptsKpiTile:
    "scripts-kpi-tile flex min-w-[5.5rem] flex-col gap-0.5 rounded-crm border px-3 py-2.5 backdrop-blur-[2px]",
  scriptsGrid:
    "grid gap-3 lg:gap-4 xl:gap-5 lg:items-stretch lg:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)_minmax(15rem,20rem)] xl:grid-cols-[minmax(17.5rem,22.5rem)_minmax(0,1fr)_minmax(17.5rem,22.5rem)]",
  scriptsLibraryCol: "flex flex-col gap-2.5 min-w-0",
  scriptsWorkspaceCol: "flex flex-col gap-2.5 min-w-0 min-h-[30rem]",
  scriptsSideCol: "flex flex-col gap-2.5 min-w-0",
  scriptsPanelSupport:
    "scripts-panel-support rounded-crm-lg border backdrop-blur-[2px]",
  scriptsPanelPrimary:
    "scripts-panel-primary relative overflow-hidden rounded-crm-lg border",
  scriptsPanelPrimaryGlow:
    "scripts-panel-primary-glow pointer-events-none absolute inset-0",
  scriptsSidePanel: "scripts-side-panel rounded-crm-lg border p-3.5",
  scriptCard:
    "group relative flex items-stretch rounded-crm border border-crm-border/60 bg-crm-surface-2/40 transition-all duration-200 hover:border-crm-border/90 hover:bg-crm-surface-2/70 cursor-pointer scripts-script-card",
  scriptCardActive:
    "border-crm-accent/45 bg-crm-accent/10 ring-1 ring-crm-accent/25 scripts-script-card-active",
  scriptCardArchived: "opacity-50",
  scriptStatusStrip: "w-1 shrink-0 rounded-l-crm",
  scriptTplCard:
    "script-template-card group relative flex w-full items-center gap-2.5 overflow-hidden rounded-crm-lg border p-3 text-left transition-all duration-200 hover:-translate-y-px cursor-pointer",
  scriptTplStrip: "absolute left-0 top-0 bottom-0 w-1 rounded-l-crm-lg",
  scriptTplIcon:
    "script-tpl-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border text-base transition-transform duration-200 group-hover:scale-105",
  scriptSectionCard:
    "scripts-section-card rounded-crm border transition-all duration-200",
  scriptSectionCardOpen: "scripts-section-card-open",
  scriptCheckStep:
    "flex w-full items-start gap-2.5 rounded-crm border px-3 py-2.5 text-left text-sm transition-all duration-200",
  scriptCheckStepDone:
    "border-crm-success/35 bg-crm-success/8 text-crm-muted",
  scriptCheckStepPending: "scripts-check-step-pending",
  scriptSectionPill: "scripts-section-pill",
  scriptSectionPillActive:
    "rounded-crm border border-crm-accent/40 bg-crm-accent/10 px-2.5 py-1 text-[11px] font-medium text-crm-accent",
  scriptModeTab: "scripts-mode-tab",
  scriptModeTabActive: "scripts-mode-tab-active",
  scriptsTipsStrip:
    "scripts-tips-strip flex flex-wrap items-center gap-x-4 gap-y-2 rounded-crm-lg border px-4 py-2.5 text-[11px] text-crm-muted",
  scriptsFeatureCard:
    "scripts-feature-card flex flex-col gap-1 rounded-crm border px-3 py-2.5 transition-colors",
  scriptsLiveCta:
    "scripts-live-cta flex w-full items-center justify-center gap-2 rounded-crm border px-4 py-3 text-sm font-semibold transition-all",
  scriptsLibraryHeader:
    "scripts-library-header flex items-center justify-between border-b px-3 py-2.5",
  scriptsLibraryCount:
    "scripts-library-count rounded-full border px-2 py-0.5 text-[10px] font-bold tabular-nums text-crm-muted",
  scriptsInsetPanel: "scripts-inset-panel rounded-crm-lg border px-4 py-3",
  scriptsWorkloadRow: "scripts-workload-row flex items-center justify-between gap-2 rounded-crm border px-2.5 py-1.5",
  scriptsShortcutCard:
    "scripts-shortcut-card flex flex-col items-center gap-1 rounded-crm border px-2 py-2.5 text-center text-[11px] font-medium transition-colors",
  scriptsEditModal: "scripts-edit-modal w-full max-w-2xl max-h-[92vh] flex flex-col",
} as const;
