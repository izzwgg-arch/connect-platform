/**
 * Phase 19E.6 — theme-aware campaign cinema (dark = mockup cinema; light = frosted SaaS).
 * Colors live in globals.css via --cinema-* / --crm-* on `.crm-campaign-cinema`.
 */
export const mk = {
  workspace: "crm-campaign-workspace crm-campaign-cinema",
  pageInner:
    "mx-auto w-full max-w-[min(100%,1680px)] px-3 py-5 sm:px-6 lg:px-8 flex flex-col gap-5 min-h-0 relative",
  atmosphere:
    "pointer-events-none absolute inset-0 -z-10 overflow-hidden cinema-atmosphere",
  heroShell: "crm-cinema-hero relative overflow-hidden rounded-2xl",
  heroInner: "relative z-[2] flex flex-col gap-6 p-5 sm:p-6 lg:p-8",
  heroTitle:
    "text-3xl font-bold tracking-tight text-[var(--cinema-text)] sm:text-[2rem] lg:text-[2.35rem]",
  heroSubtitle:
    "mt-2 max-w-2xl text-sm leading-relaxed text-[var(--cinema-text-muted)] sm:text-[0.9375rem]",
  heroActions: "flex flex-wrap items-center gap-3 shrink-0",
  btnPrimary: "cinema-btn-primary",
  btnSecondary: "cinema-btn-secondary",
  btnGreen: "cinema-btn-green",
  btnQueueRow: "cinema-btn-queue",
  kpiGrid: "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5",
  kpiCard:
    "crm-cinema-kpi-card relative flex min-h-[7.5rem] flex-col overflow-hidden rounded-2xl p-4",
  kpiLabel:
    "text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--cinema-text-muted)]",
  kpiValue:
    "mt-1 text-[1.75rem] font-bold tabular-nums leading-none text-[var(--cinema-text)] sm:text-[2rem]",
  kpiSub: "mt-1 text-[11px] font-medium",
  kpiSpark: "mt-auto h-9 w-full opacity-90",
  rowList: "m-0 flex list-none flex-col gap-3 p-0",
  rowShell:
    "crm-cinema-row group relative flex min-h-[7.25rem] w-full min-w-0 flex-col overflow-hidden rounded-2xl transition-[border-color,box-shadow] duration-300 lg:min-h-[6.5rem] lg:flex-row lg:items-stretch",
  rowActive: "crm-cinema-row-active",
  rowPaused: "crm-cinema-row-paused",
  rowBadge:
    "cinema-row-badge flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border-2 text-lg font-bold sm:h-16 sm:w-16",
  rowIdentity: "min-w-0 flex-1 px-4 py-4 lg:py-5",
  rowName:
    "text-lg font-bold text-[var(--cinema-text)] hover:text-[var(--cinema-accent-blue)] sm:text-xl",
  rowDesc: "mt-1 line-clamp-2 text-sm text-[var(--cinema-text-muted)]",
  rowMeta: "mt-2 text-[11px] text-[var(--cinema-text-dim)]",
  rowMetrics:
    "flex shrink-0 flex-wrap items-center gap-0 border-t border-[color:var(--cinema-border-subtle)] px-4 py-3 lg:border-l lg:border-t-0 lg:px-6 lg:py-0",
  rowMetricCol:
    "flex min-w-[4.5rem] flex-col gap-0.5 px-3 py-2 lg:min-w-[5.25rem] lg:border-r lg:border-[color:var(--cinema-border-subtle)] lg:last:border-r-0",
  rowMetricLabel:
    "text-[10px] font-bold uppercase tracking-wider text-[var(--cinema-text-dim)]",
  rowMetricValue: "text-xl font-bold tabular-nums text-[var(--cinema-text)]",
  rowActions:
    "flex flex-col justify-center gap-2 border-t border-[color:var(--cinema-border-subtle)] p-4 lg:min-w-[12.5rem] lg:border-l lg:border-t-0 lg:px-5",
  rowOpenBtn: "cinema-btn-open-row",
  filterBar: "crm-cinema-filter-bar relative z-20 rounded-2xl p-3 sm:p-4",
  searchInput: "crm-cinema-search w-full rounded-xl py-2.5 pl-10 pr-4 text-sm",
  filterPillGroup: "cinema-filter-pill-group flex flex-wrap gap-1 rounded-xl p-1",
  filterPill: "cinema-filter-pill rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
  filterPillActive: "cinema-filter-pill-active",
  stripDock: "crm-cinema-strip-dock fixed bottom-0 left-0 right-0 z-40 px-3 py-3 backdrop-blur-xl sm:px-6",
  stripGrid: "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4",
  stripCard:
    "crm-cinema-strip-card group flex min-h-[5.5rem] items-start gap-3 rounded-2xl p-4 text-left transition-[border-color,transform,box-shadow] disabled:opacity-45",
  stripIcon: "cinema-strip-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
  stripTitle: "text-sm font-bold text-[var(--cinema-text)]",
  stripHint: "mt-0.5 text-xs leading-snug text-[var(--cinema-text-muted)]",
  stripKbd:
    "rounded border border-[color:var(--cinema-border)] bg-[color:var(--cinema-surface-soft)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--cinema-text-muted)]",
  detailHero: "crm-cinema-detail-hero relative overflow-hidden rounded-2xl",
  detailHeroInner: "relative z-[2] p-5 sm:p-6 lg:p-7",
  breadcrumb: "text-xs font-medium text-[var(--cinema-text-dim)]",
  detailTitleRow: "mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between",
  detailKpiBand: "mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6",
  detailKpiTile: "crm-cinema-detail-kpi rounded-xl px-3 py-3",
  detailKpiValue: "text-2xl font-bold tabular-nums text-[var(--cinema-text)]",
  perfShell: "crm-cinema-perf relative overflow-hidden rounded-2xl",
  perfGrid:
    "grid gap-4 lg:grid-cols-3 lg:gap-0 lg:divide-x lg:divide-[color:var(--cinema-border-subtle)]",
  perfWidget: "relative flex min-h-[14rem] flex-col p-5 sm:p-6 lg:min-h-[16rem]",
  perfWidgetGlow: "pointer-events-none absolute inset-0 opacity-80 cinema-perf-glow",
  perfSectionTitle: "text-lg font-bold text-[var(--cinema-text)]",
  perfSectionSub: "mt-0.5 text-xs text-[var(--cinema-text-muted)]",
  opsGrid: "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4",
  opsCard: "crm-cinema-ops-card flex min-h-[11rem] flex-col rounded-2xl p-4 sm:p-5",
  opsTitle: "text-sm font-bold text-[var(--cinema-text)]",
  opsAlert: "crm-cinema-ops-alert rounded-xl px-3 py-3",
  rosterShell: "crm-cinema-roster overflow-hidden rounded-2xl",
  rosterHead:
    "border-b border-[color:var(--cinema-border-subtle)] px-4 py-4 sm:px-6 cinema-roster-head",
  rosterToolbar:
    "flex flex-wrap items-center gap-2 border-b border-[color:var(--cinema-border-subtle)] px-4 py-3 sm:px-6",
  rosterTableHead:
    "crm-cinema-roster-thead hidden lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.65fr)_minmax(0,0.7fr)_repeat(4,minmax(0,0.55fr))_minmax(0,0.6fr)_auto] lg:gap-3 lg:px-6 lg:py-2.5 text-[10px] font-bold uppercase tracking-wider text-[var(--cinema-text-dim)]",
  memberRow:
    "crm-cinema-member-row grid grid-cols-1 gap-2 border-b border-[color:var(--cinema-border-subtle)] px-4 py-3 transition-[background,box-shadow] last:border-b-0 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.65fr)_minmax(0,0.7fr)_repeat(4,minmax(0,0.55fr))_minmax(0,0.6fr)_auto] lg:items-center lg:gap-3 lg:px-6 lg:py-3.5",
  memberAvatar:
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm font-bold cinema-member-avatar",
  pill:
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
  statusPillActive: "cinema-pill-active",
  statusPillPaused: "cinema-pill-paused",
  btnPowerOrange: "cinema-btn-power-orange",
  menuPanel: "crm-cinema-overflow-menu",
  menuItem: "crm-cinema-overflow-item",
  menuItemWarn: "crm-cinema-overflow-item-warn",
  menuItemDanger: "crm-cinema-overflow-item-danger",
} as const;

export type CampaignKpiAccent = "green" | "amber" | "violet" | "orange" | "cyan" | "blue";

export const KPI_ACCENT: Record<
  CampaignKpiAccent,
  { border: string; glow: string; spark: string; sub: string }
> = {
  green: {
    border: "cinema-kpi-accent-green-border",
    glow: "cinema-kpi-accent-green-glow",
    spark: "#34d399",
    sub: "cinema-kpi-sub-green",
  },
  amber: {
    border: "cinema-kpi-accent-amber-border",
    glow: "cinema-kpi-accent-amber-glow",
    spark: "#fbbf24",
    sub: "cinema-kpi-sub-amber",
  },
  violet: {
    border: "cinema-kpi-accent-violet-border",
    glow: "cinema-kpi-accent-violet-glow",
    spark: "#a78bfa",
    sub: "cinema-kpi-sub-violet",
  },
  orange: {
    border: "cinema-kpi-accent-orange-border",
    glow: "cinema-kpi-accent-orange-glow",
    spark: "#fb923c",
    sub: "cinema-kpi-sub-orange",
  },
  cyan: {
    border: "cinema-kpi-accent-cyan-border",
    glow: "cinema-kpi-accent-cyan-glow",
    spark: "#22d3ee",
    sub: "cinema-kpi-sub-cyan",
  },
  blue: {
    border: "cinema-kpi-accent-blue-border",
    glow: "cinema-kpi-accent-blue-glow",
    spark: "#60a5fa",
    sub: "cinema-kpi-sub-blue",
  },
};

export const ROW_STATUS: Record<
  string,
  { badge: string; icon: string; edge?: string }
> = {
  ACTIVE: {
    badge: "cinema-row-badge-active",
    icon: "cinema-icon-active",
    edge: "cinema-row-edge-active",
  },
  PAUSED: {
    badge: "cinema-row-badge-paused",
    icon: "cinema-icon-paused",
    edge: "cinema-row-edge-paused",
  },
  DRAFT: {
    badge: "cinema-row-badge-draft",
    icon: "cinema-icon-draft",
  },
  COMPLETED: {
    badge: "cinema-row-badge-completed",
    icon: "cinema-icon-completed",
  },
  ARCHIVED: {
    badge: "cinema-row-badge-archived",
    icon: "cinema-icon-archived",
  },
};

export const STRIP_ACCENT: Record<string, { card: string; icon: string }> = {
  new: {
    card: "cinema-strip-hover-teal",
    icon: "cinema-strip-icon-teal",
  },
  power: {
    card: "cinema-strip-hover-orange",
    icon: "cinema-strip-icon-orange",
  },
  queue: {
    card: "cinema-strip-hover-violet",
    icon: "cinema-strip-icon-violet",
  },
  callbacks: {
    card: "cinema-strip-hover-amber",
    icon: "cinema-strip-icon-amber",
  },
};
