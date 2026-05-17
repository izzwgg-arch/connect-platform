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
  /** Forces dark CRM tokens even when portal data-theme=light (campaign routes only). */
  campaignWorkspace:
    "crm-campaign-workspace [color-scheme:dark] [--panel:#141f2b] [--panel-2:#1a2635] [--bg-soft:#101923] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#141f2b] [--crm-surface-2:#1a2635] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a]",
  /** Phase 19D.2 — contacts index command bar stays dark when portal data-theme=light */
  contactsWorkspace:
    "crm-contacts-workspace [color-scheme:dark] [--panel:#141f2b] [--panel-2:#1a2635] [--bg-soft:#101923] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#141f2b] [--crm-surface-2:#1a2635] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a]",
  /** Phase 19E.3 — detail page vertical stack (no skinny aside rail) */
  campaignDetailStack: "flex w-full min-w-0 flex-col gap-3",
  campaignDetailCommandGrid:
    "grid w-full min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4",
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
  /** Phase 19F — live call agent workspace */
  pageInnerLive:
    "mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8 flex flex-col gap-4 min-h-0",
  /** Phase 19G — wallboard command center forces dark CRM tokens even when portal data-theme=light */
  wallboardWorkspace:
    "crm-wallboard-workspace [color-scheme:dark] [--panel:#141f2b] [--panel-2:#1a2635] [--bg-soft:#101923] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#141f2b] [--crm-surface-2:#1a2635] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a]",
  /** Phase 19K — CRM Intelligence reports workspace (full dark, no light surfaces) */
  reportsWorkspace:
    "crm-reports-workspace [color-scheme:dark] [--panel:#141f2b] [--panel-2:#1a2635] [--bg-soft:#101923] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#141f2b] [--crm-surface-2:#1a2635] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a]",
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

  /** Phase 19D.2 — contacts command bar filter pills (dark surfaces, no white capsules) */
  filterPill:
    "rounded-full border border-crm-border bg-crm-surface-2 px-3 py-1.5 text-xs font-medium text-crm-text transition-colors hover:border-crm-border/90 hover:bg-crm-surface [color-scheme:dark]",
  filterPillActive:
    "rounded-full border border-crm-accent/50 bg-crm-accent px-3 py-1.5 text-xs font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] [color-scheme:dark]",
  filterPillGroup:
    "inline-flex flex-wrap items-center gap-1.5 rounded-full border border-crm-border/70 bg-crm-surface-2/50 px-2 py-1 [color-scheme:dark]",
  checkbox:
    "h-4 w-4 shrink-0 cursor-pointer rounded border border-crm-border bg-crm-surface-2 text-crm-accent accent-crm-accent focus:ring-2 focus:ring-crm-accent/30 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50 [color-scheme:dark]",
  selectCompact:
    "rounded-crm border border-crm-border !bg-crm-surface-2 px-2 py-1.5 text-sm !text-crm-text shadow-none focus:border-crm-accent/50 focus:!bg-crm-surface focus:outline-none focus:ring-2 focus:ring-crm-accent/30 disabled:cursor-not-allowed disabled:opacity-70 [color-scheme:dark]",

  /** Phase 19C.1 — queue filter count pills (always dark surface). */
  queueCountPill:
    "flex h-full min-h-[4.25rem] w-full min-w-0 flex-col items-start justify-center rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2.5 text-left transition-all hover:border-crm-border/90 hover:bg-crm-surface",
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

  /** Queue command sidebar — consistent dark surfaces, even rhythm */
  sidebarCard: "border-crm-border bg-crm-surface shadow-crm",
  sidebarSection: "flex flex-col gap-2 py-0.5",
  metricTile:
    "flex flex-col justify-between rounded-crm border border-crm-border bg-crm-surface-2 px-2.5 py-2",

  /** Phase 19H — task command desk (wide, two-column) */
  pageInnerTasks:
    "mx-auto w-full max-w-[min(100%,1500px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-3 min-h-0",
  /** Forces dark CRM tokens on task routes when portal data-theme=light */
  tasksWorkspace:
    "crm-tasks-workspace [color-scheme:dark] [--panel:#141f2b] [--panel-2:#1a2635] [--bg-soft:#101923] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#141f2b] [--crm-surface-2:#1a2635] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a]",
  tasksGrid: "grid gap-4 lg:grid-cols-12 lg:items-start",
  tasksMainCol: "lg:col-span-8 xl:col-span-9 flex flex-col gap-3 min-w-0",
  tasksSideCol:
    "lg:col-span-4 xl:col-span-3 flex flex-col gap-3 min-w-0 lg:min-w-[16rem]",

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
    "mx-auto w-full max-w-[min(100%,1600px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-3 min-h-0",
  /** Forces dark CRM tokens on checklist routes when portal data-theme=light */
  checklistWorkspace:
    "crm-checklist-workspace [color-scheme:dark] [--panel:#101a2d] [--panel-2:#13203a] [--bg-soft:#081120] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#101a2d] [--crm-surface-2:#13203a] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a]",
  checklistCommandHeader:
    "relative overflow-hidden rounded-crm-lg border border-crm-border/60 bg-gradient-to-br from-[#13203a] via-[#101a2d] to-[#081120] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.05)]",
  checklistCommandHeaderGlow:
    "pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_80%_at_10%_-20%,rgba(56,189,248,0.12),transparent_50%),radial-gradient(ellipse_50%_60%_at_90%_100%,rgba(99,102,241,0.06),transparent_55%)]",
  checklistCommandIcon:
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-crm-lg border border-crm-accent/35 bg-crm-accent/12 text-crm-accent shadow-[0_0_28px_-6px_rgba(56,189,248,0.4)]",
  checklistKpiTile:
    "rounded-crm border px-3 py-2.5 transition-colors hover:border-crm-border/80",
  checklistTab:
    "rounded-crm px-3.5 py-1.5 text-xs font-medium text-crm-muted transition-all hover:bg-crm-surface-2/50 hover:text-crm-text",
  checklistTabActive:
    "rounded-crm border border-crm-accent/45 bg-crm-accent/12 px-3.5 py-1.5 text-xs font-semibold text-crm-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
  checklistTipsStrip:
    "rounded-crm-lg border border-crm-border/45 bg-gradient-to-r from-[#101a2d] via-[#0d1522] to-[#101a2d] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
  checklistTipSegment:
    "flex min-w-0 flex-1 items-center gap-2.5 rounded-crm border border-transparent px-2.5 py-2 transition-colors hover:border-crm-border/40 hover:bg-[#13203a]/60",
  checklistOnboardingOrb:
    "relative flex h-24 w-24 items-center justify-center rounded-full border border-crm-accent/30 bg-crm-accent/10 shadow-[0_0_48px_-8px_rgba(56,189,248,0.45)]",
  checklistOnboardingOrbPulse:
    "pointer-events-none absolute inset-0 rounded-full bg-crm-accent/15 checklist-orb-pulse",
  checklistFeatureCard:
    "flex flex-col gap-1 rounded-crm border border-crm-border/50 bg-[#101923]/80 px-3 py-2.5 transition-all hover:border-crm-border/80 hover:bg-[#13203a]/90",
  checklistGrid: "grid gap-3 lg:grid-cols-12 lg:items-start",
  checklistLibraryCol:
    "lg:col-span-3 xl:col-span-3 flex flex-col gap-2.5 min-w-0",
  checklistWorkspaceCol:
    "lg:col-span-6 xl:col-span-6 flex flex-col gap-2.5 min-w-0 min-h-[28rem]",
  checklistSideCol:
    "lg:col-span-3 xl:col-span-3 flex flex-col gap-2.5 min-w-0",
  /** Quieter support column (library + progress) */
  checklistPanelSupport:
    "rounded-crm-lg border border-crm-border/45 bg-[#121a24]/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-[2px]",
  /** Primary center workspace — layered navy depth */
  checklistPanelPrimary:
    "relative overflow-hidden rounded-crm-lg border border-crm-border/70 bg-gradient-to-b from-[#1c2a3a] via-[#141f2b] to-[#0f1720] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.05)]",
  checklistPanelPrimaryGlow:
    "pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(56,189,248,0.08),transparent_55%)]",
  checklistWorkspaceHeader:
    "border-b border-crm-border/50 bg-gradient-to-r from-crm-surface-2/40 via-transparent to-transparent px-4 py-3",
  checklistHeroBand:
    "relative overflow-hidden rounded-crm-lg border border-crm-border/50 bg-gradient-to-br from-crm-surface-2/80 via-[#141f2b] to-[#101923] px-4 py-4 sm:px-5",
  checklistHeroGlow:
    "pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-crm-accent/10 blur-2xl",
  /** Checklist card in library */
  checklistCard:
    "group relative flex items-stretch rounded-crm border border-crm-border/60 bg-crm-surface-2/40 transition-all duration-200 hover:border-crm-border/90 hover:bg-crm-surface-2/70 hover:shadow-[0_4px_16px_-6px_rgba(0,0,0,0.4)] cursor-pointer",
  checklistCardActive:
    "border-crm-accent/45 bg-crm-accent/10 ring-1 ring-crm-accent/25 shadow-[0_0_20px_-8px_rgba(56,189,248,0.2)]",
  checklistCardArchived: "opacity-50",
  checklistStatusStrip: "w-1 shrink-0 rounded-l-crm",
  /** Workflow step card in workspace */
  checklistStepCard:
    "flex w-full items-start gap-3 rounded-crm border px-3 py-2.5 text-left text-sm transition-all duration-200",
  checklistStepPending:
    "border-crm-border/60 bg-[#1a2635]/80 text-crm-text shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] hover:border-crm-border hover:bg-[#1e2d3d]/90",
  checklistStepRequired:
    "border-crm-warning/40 bg-gradient-to-r from-crm-warning/8 to-transparent text-crm-text shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_0_16px_-8px_rgba(245,158,11,0.15)]",
  checklistStepNum:
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crm-border/70 bg-[#101923] text-[11px] font-bold tabular-nums text-crm-muted",
  checklistStepNumRequired:
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crm-warning/50 bg-crm-warning/15 text-[11px] font-bold tabular-nums text-crm-warning shadow-[0_0_10px_-4px_rgba(245,158,11,0.35)]",
  /** Template card base (accent via TEMPLATE_ACCENT_CLASSES) */
  checklistTemplateCard:
    "checklist-template-card group relative flex w-full flex-col gap-2 overflow-hidden rounded-crm-lg border border-crm-border/55 bg-gradient-to-br from-[#1a2635]/90 to-[#101923]/95 p-3.5 text-left transition-all duration-200 hover:-translate-y-px cursor-pointer",
  checklistTemplateStrip: "absolute left-0 top-0 bottom-0 w-1 rounded-l-crm-lg",
  checklistTemplateIcon:
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border text-lg transition-transform duration-200 group-hover:scale-105",
  checklistMetricChip:
    "inline-flex items-center gap-1 rounded-crm border border-crm-border/50 bg-[#101923]/60 px-2 py-0.5 text-[10px] font-medium tabular-nums text-crm-muted",
  checklistProgressCard:
    "rounded-crm-lg border border-crm-border/45 bg-gradient-to-b from-[#161f2b] to-[#101923] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",

  /** Phase 19I / 19I.1 — scripts premium playbook command center */
  pageInnerScripts:
    "mx-auto w-full max-w-[min(100%,1680px)] px-3 py-4 sm:px-5 lg:px-6 xl:px-7 flex flex-col gap-3 min-h-0",
  scriptsWorkspace:
    "crm-scripts-workspace [color-scheme:dark] [--panel:#141f2b] [--panel-2:#1a2635] [--bg-soft:#0a0e14] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#141f2b] [--crm-surface-2:#1a2635] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a]",
  scriptsHero:
    "relative overflow-hidden rounded-crm-lg border border-crm-border/60 bg-gradient-to-br from-[#1c2a3a] via-[#141f2b] to-[#0d1218] px-4 py-4 sm:px-5 sm:py-5 shadow-[0_8px_32px_-12px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.05)]",
  scriptsHeroGlow:
    "pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-crm-accent/12 blur-3xl",
  scriptsHeroIcon:
    "flex h-12 w-12 shrink-0 items-center justify-center rounded-crm-lg border border-crm-accent/30 bg-crm-accent/10 text-crm-accent shadow-[0_0_32px_-8px_rgba(56,189,248,0.45)]",
  scriptsKpiTile:
    "flex min-w-[5.5rem] flex-col gap-0.5 rounded-crm border border-crm-border/50 bg-[#101923]/70 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-[2px]",
  scriptsGrid: "grid gap-3 lg:grid-cols-12 lg:items-stretch",
  scriptsLibraryCol: "lg:col-span-3 flex flex-col gap-2.5 min-w-0",
  scriptsWorkspaceCol: "lg:col-span-6 flex flex-col gap-2.5 min-w-0 min-h-[28rem]",
  scriptsSideCol: "lg:col-span-3 flex flex-col gap-2.5 min-w-0",
  scriptsPanelSupport:
    "rounded-crm-lg border border-crm-border/45 bg-[#121a24]/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-[2px]",
  scriptsPanelPrimary:
    "relative overflow-hidden rounded-crm-lg border border-crm-border/70 bg-gradient-to-b from-[#1c2a3a] via-[#141f2b] to-[#0f1720] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.05)]",
  scriptsPanelPrimaryGlow:
    "pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(56,189,248,0.1),transparent_55%)]",
  scriptsSidePanel:
    "rounded-crm-lg border border-crm-border/45 bg-gradient-to-b from-[#161f2b] to-[#101923] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
  scriptCard:
    "group relative flex items-stretch rounded-crm border border-crm-border/60 bg-crm-surface-2/40 transition-all duration-200 hover:border-crm-border/90 hover:bg-crm-surface-2/70 hover:shadow-[0_4px_16px_-6px_rgba(0,0,0,0.4)] cursor-pointer",
  scriptCardActive:
    "border-crm-accent/45 bg-crm-accent/10 ring-1 ring-crm-accent/25 shadow-[0_0_20px_-8px_rgba(56,189,248,0.2)]",
  scriptCardArchived: "opacity-50",
  scriptStatusStrip: "w-1 shrink-0 rounded-l-crm",
  scriptTplCard:
    "script-template-card group relative flex w-full items-center gap-2.5 overflow-hidden rounded-crm-lg border border-crm-border/55 bg-gradient-to-br from-[#1a2635]/90 to-[#101923]/95 p-3 text-left transition-all duration-200 hover:-translate-y-px cursor-pointer",
  scriptTplStrip: "absolute left-0 top-0 bottom-0 w-1 rounded-l-crm-lg",
  scriptTplIcon:
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border text-base transition-transform duration-200 group-hover:scale-105",
  scriptSectionCard:
    "rounded-crm border border-crm-border/60 bg-[#1a2635]/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-all duration-200",
  scriptSectionCardOpen:
    "border-crm-border/80 shadow-[0_4px_20px_-10px_rgba(0,0,0,0.5)]",
  scriptCheckStep:
    "flex w-full items-start gap-2.5 rounded-crm border px-3 py-2.5 text-left text-sm transition-all duration-200",
  scriptCheckStepDone:
    "border-crm-success/35 bg-crm-success/8 text-crm-muted",
  scriptCheckStepPending:
    "border-crm-border/60 bg-[#101923]/60 text-crm-text hover:border-crm-border hover:bg-[#1a2635]/80",
  scriptSectionPill:
    "rounded-crm border border-crm-border/60 bg-[#101923]/60 px-2.5 py-1 text-[11px] font-medium text-crm-muted transition-colors hover:border-crm-border hover:bg-crm-surface-2 hover:text-crm-text",
  scriptSectionPillActive:
    "rounded-crm border border-crm-accent/40 bg-crm-accent/10 px-2.5 py-1 text-[11px] font-medium text-crm-accent",
  scriptModeTab:
    "inline-flex items-center gap-1.5 rounded-crm border border-crm-border/70 bg-[#101923]/60 px-3 py-1.5 text-xs font-medium text-crm-muted transition-colors hover:border-crm-border hover:text-crm-text",
  scriptModeTabActive:
    "inline-flex items-center gap-1.5 rounded-crm border border-crm-accent/50 bg-crm-accent/12 px-3 py-1.5 text-xs font-medium text-crm-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
  scriptsTipsStrip:
    "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-crm-lg border border-crm-border/45 bg-[#101923]/80 px-4 py-2.5 text-[11px] text-crm-muted shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
  scriptsFeatureCard:
    "flex flex-col gap-1 rounded-crm border border-crm-border/40 bg-[#101923]/50 px-3 py-2.5 transition-colors hover:border-crm-border/70 hover:bg-[#141f2b]/80",
  scriptsLiveCta:
    "flex w-full items-center justify-center gap-2 rounded-crm border border-crm-accent/40 bg-gradient-to-r from-crm-accent/20 to-crm-accent/5 px-4 py-3 text-sm font-semibold text-crm-accent shadow-[0_0_24px_-8px_rgba(56,189,248,0.35)] transition-all hover:border-crm-accent/60 hover:shadow-[0_0_32px_-8px_rgba(56,189,248,0.45)]",
} as const;
