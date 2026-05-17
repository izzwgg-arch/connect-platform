/**
 * Phase 19E.5 — mockup-faithful campaign cinema (not generic CRM tokens).
 */
export const mk = {
  workspace:
    "crm-campaign-workspace crm-campaign-cinema [color-scheme:dark] [--panel:#0c1018] [--panel-2:#121a28] [--bg-soft:#080b12] [--text:#f0f4f9] [--text-dim:#8b9cb3] [--border:#2a3a52] [--crm-surface:#121a28] [--crm-surface-2:#161f2e] [--crm-text:#f0f4f9] [--crm-text-muted:#8b9cb3] [--crm-border:#2a3a52]",
  pageInner:
    "mx-auto w-full max-w-[min(100%,1680px)] px-3 py-5 sm:px-6 lg:px-8 flex flex-col gap-5 min-h-0 relative",
  atmosphere:
    "pointer-events-none absolute inset-0 -z-10 overflow-hidden",
  heroShell:
    "crm-cinema-hero relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#121a28]/90 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.75),inset_0_1px_0_rgba(255,255,255,0.06)]",
  heroInner: "relative z-[2] flex flex-col gap-6 p-5 sm:p-6 lg:p-8",
  heroTitle: "text-3xl font-bold tracking-tight text-white sm:text-[2rem] lg:text-[2.35rem]",
  heroSubtitle: "mt-2 max-w-2xl text-sm leading-relaxed text-[#9aa8be] sm:text-[0.9375rem]",
  heroActions: "flex flex-wrap items-center gap-3 shrink-0",
  btnPrimary:
    "inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-[#3b9eff] to-[#2563eb] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_32px_-6px_rgba(59,130,246,0.65),0_8px_24px_-8px_rgba(37,99,235,0.5)] transition-[filter,transform] hover:brightness-110 active:scale-[0.98]",
  btnSecondary:
    "inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#1a2438]/90 px-5 py-2.5 text-sm font-semibold text-[#e8eef7] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:border-white/18 hover:bg-[#222d45]",
  btnGreen:
    "inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-[#34d399] to-[#059669] px-5 py-3 text-sm font-bold text-white shadow-[0_0_40px_-8px_rgba(52,211,153,0.55)] hover:brightness-110",
  btnQueueRow:
    "inline-flex items-center justify-center gap-2 rounded-xl border border-white/12 bg-[#1c263c] px-4 py-2.5 text-sm font-semibold text-[#e2e9f4] hover:border-[#3b82f6]/40 hover:bg-[#243049]",
  kpiGrid: "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5",
  kpiCard:
    "crm-cinema-kpi-card relative flex min-h-[7.5rem] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-[#1a2438]/95 to-[#121a28]/90 p-4 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.05)]",
  kpiLabel: "text-[10px] font-bold uppercase tracking-[0.12em] text-[#8b9cb3]",
  kpiValue: "mt-1 text-[1.75rem] font-bold tabular-nums leading-none text-white sm:text-[2rem]",
  kpiSub: "mt-1 text-[11px] font-medium",
  kpiSpark: "mt-auto h-9 w-full opacity-90",
  rowList: "m-0 flex list-none flex-col gap-3 p-0",
  rowShell:
    "crm-cinema-row group relative flex min-h-[7.25rem] w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-gradient-to-r from-[#141c2c]/95 via-[#121a28]/98 to-[#101722]/95 shadow-[0_16px_48px_-20px_rgba(0,0,0,0.7)] transition-[border-color,box-shadow] duration-300 lg:min-h-[6.5rem] lg:flex-row lg:items-stretch",
  rowActive:
    "crm-cinema-row-active border-[#34d399]/45 shadow-[0_0_0_1px_rgba(52,211,153,0.2),0_0_48px_-8px_rgba(52,211,153,0.35),inset_0_0_60px_-40px_rgba(52,211,153,0.12)]",
  rowPaused:
    "border-[#f59e0b]/35 shadow-[0_0_32px_-12px_rgba(245,158,11,0.25)]",
  rowBadge:
    "flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border-2 text-lg font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] sm:h-16 sm:w-16",
  rowIdentity: "min-w-0 flex-1 px-4 py-4 lg:py-5",
  rowName: "text-lg font-bold text-white hover:text-[#60a5fa] sm:text-xl",
  rowDesc: "mt-1 line-clamp-2 text-sm text-[#9aa8be]",
  rowMeta: "mt-2 text-[11px] text-[#6d7f99]",
  rowMetrics:
    "flex shrink-0 flex-wrap items-center gap-0 border-t border-white/[0.06] px-4 py-3 lg:border-l lg:border-t-0 lg:px-6 lg:py-0",
  rowMetricCol: "flex min-w-[4.5rem] flex-col gap-0.5 px-3 py-2 lg:min-w-[5.25rem] lg:border-r lg:border-white/[0.06] lg:last:border-r-0",
  rowMetricLabel: "text-[10px] font-bold uppercase tracking-wider text-[#6d7f99]",
  rowMetricValue: "text-xl font-bold tabular-nums text-white",
  rowActions:
    "flex flex-col justify-center gap-2 border-t border-white/[0.06] p-4 lg:min-w-[12.5rem] lg:border-l lg:border-t-0 lg:px-5",
  rowOpenBtn:
    "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-[#3b9eff] to-[#2563eb] px-5 py-3 text-sm font-bold text-white shadow-[0_0_28px_-6px_rgba(59,130,246,0.55)] hover:brightness-110",
  filterBar:
    "relative z-20 rounded-2xl border border-white/[0.07] bg-[#121a28]/85 p-3 shadow-[0_8px_32px_-16px_rgba(0,0,0,0.55)] backdrop-blur-md sm:p-4",
  searchInput:
    "w-full rounded-xl border border-white/10 bg-[#0f1522]/90 py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-[#6d7f99] focus:border-[#3b82f6]/50 focus:outline-none focus:ring-2 focus:ring-[#3b82f6]/25",
  stripGrid: "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4",
  stripCard:
    "crm-cinema-strip-card group flex min-h-[5.5rem] items-start gap-3 rounded-2xl border border-white/[0.08] bg-gradient-to-br from-[#1a2438]/90 to-[#101722]/95 p-4 text-left shadow-[0_12px_36px_-14px_rgba(0,0,0,0.6)] transition-[border-color,transform,box-shadow] hover:border-white/14 hover:shadow-[0_16px_44px_-12px_rgba(0,0,0,0.55)] disabled:opacity-45",
  stripIcon:
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]",
  stripTitle: "text-sm font-bold text-white",
  stripHint: "mt-0.5 text-xs leading-snug text-[#8b9cb3]",
  detailHero:
    "crm-cinema-detail-hero relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#121a28]/95 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.8)]",
  detailHeroInner: "relative z-[2] p-5 sm:p-6 lg:p-7",
  breadcrumb: "text-xs font-medium text-[#6d7f99]",
  detailTitleRow: "mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between",
  detailKpiBand: "mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6",
  detailKpiTile:
    "rounded-xl border border-white/[0.08] bg-[#161f2e]/90 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
  detailKpiValue: "text-2xl font-bold tabular-nums text-white",
  perfShell:
    "crm-cinema-perf relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#121a28]/95 shadow-[0_20px_64px_-20px_rgba(0,0,0,0.75)]",
  perfGrid: "grid gap-4 lg:grid-cols-3 lg:gap-0 lg:divide-x lg:divide-white/[0.06]",
  perfWidget: "relative flex min-h-[14rem] flex-col p-5 sm:p-6 lg:min-h-[16rem]",
  perfWidgetGlow: "pointer-events-none absolute inset-0 opacity-80",
  opsGrid: "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4",
  opsCard:
    "crm-cinema-ops-card flex min-h-[11rem] flex-col rounded-2xl border border-white/[0.08] bg-gradient-to-b from-[#1a2438]/80 to-[#121a28]/95 p-4 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.04)] sm:p-5",
  opsTitle: "text-sm font-bold text-white",
  rosterShell:
    "crm-cinema-roster overflow-hidden rounded-2xl border border-white/[0.08] bg-[#121a28]/95 shadow-[0_20px_64px_-20px_rgba(0,0,0,0.75)]",
  rosterHead:
    "border-b border-white/[0.06] bg-[#161f2e]/60 px-4 py-4 sm:px-6",
  rosterTableHead:
    "hidden lg:grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.65fr)_minmax(0,0.7fr)_repeat(4,minmax(0,0.55fr))_minmax(0,0.6fr)_auto] lg:gap-3 lg:border-b lg:border-white/[0.06] lg:bg-[#0f1522]/50 lg:px-6 lg:py-2.5 text-[10px] font-bold uppercase tracking-wider text-[#6d7f99]",
  memberRow:
    "crm-cinema-member-row grid grid-cols-1 gap-2 border-b border-white/[0.04] px-4 py-3 transition-[background,box-shadow] last:border-b-0 hover:bg-[#1a2438]/40 hover:shadow-[inset_0_0_24px_-12px_rgba(59,130,246,0.15)] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.65fr)_minmax(0,0.7fr)_repeat(4,minmax(0,0.55fr))_minmax(0,0.6fr)_auto] lg:items-center lg:gap-3 lg:px-6 lg:py-3.5",
  pill:
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
  statusPillActive: "border-[#34d399]/40 bg-[#34d399]/15 text-[#6ee7b7]",
  statusPillPaused: "border-[#fbbf24]/40 bg-[#fbbf24]/12 text-[#fcd34d]",
} as const;

export type CampaignKpiAccent = "green" | "amber" | "violet" | "orange" | "cyan" | "blue";

export const KPI_ACCENT: Record<
  CampaignKpiAccent,
  { border: string; glow: string; spark: string; sub: string }
> = {
  green: {
    border: "border-[#34d399]/30",
    glow: "shadow-[0_0_40px_-12px_rgba(52,211,153,0.35)]",
    spark: "#34d399",
    sub: "text-[#6ee7b7]",
  },
  amber: {
    border: "border-[#fbbf24]/30",
    glow: "shadow-[0_0_40px_-12px_rgba(251,191,36,0.3)]",
    spark: "#fbbf24",
    sub: "text-[#fcd34d]",
  },
  violet: {
    border: "border-[#a78bfa]/30",
    glow: "shadow-[0_0_40px_-12px_rgba(167,139,250,0.3)]",
    spark: "#a78bfa",
    sub: "text-[#c4b5fd]",
  },
  orange: {
    border: "border-[#fb923c]/30",
    glow: "shadow-[0_0_40px_-12px_rgba(251,146,60,0.3)]",
    spark: "#fb923c",
    sub: "text-[#fdba74]",
  },
  cyan: {
    border: "border-[#22d3ee]/30",
    glow: "shadow-[0_0_40px_-12px_rgba(34,211,238,0.28)]",
    spark: "#22d3ee",
    sub: "text-[#67e8f9]",
  },
  blue: {
    border: "border-[#60a5fa]/30",
    glow: "shadow-[0_0_40px_-12px_rgba(96,165,250,0.28)]",
    spark: "#60a5fa",
    sub: "text-[#93c5fd]",
  },
};

export const ROW_STATUS: Record<
  string,
  { badge: string; icon: string; edge?: string }
> = {
  ACTIVE: {
    badge: "border-[#34d399]/50 bg-[#34d399]/15 text-[#6ee7b7]",
    icon: "text-[#34d399]",
    edge: "from-[#34d399]",
  },
  PAUSED: {
    badge: "border-[#fbbf24]/45 bg-[#fbbf24]/12 text-[#fcd34d]",
    icon: "text-[#fbbf24]",
    edge: "from-[#fbbf24]",
  },
  DRAFT: {
    badge: "border-white/15 bg-white/5 text-[#9aa8be]",
    icon: "text-[#9aa8be]",
  },
  COMPLETED: {
    badge: "border-[#60a5fa]/35 bg-[#60a5fa]/10 text-[#93c5fd]",
    icon: "text-[#60a5fa]",
  },
  ARCHIVED: {
    badge: "border-white/10 bg-white/5 text-[#6d7f99]",
    icon: "text-[#6d7f99]",
  },
};

export const STRIP_ACCENT: Record<string, { card: string; icon: string }> = {
  new: {
    card: "hover:border-[#2dd4bf]/25",
    icon: "border-[#2dd4bf]/35 bg-[#2dd4bf]/15 text-[#5eead4]",
  },
  power: {
    card: "hover:border-[#fb923c]/25",
    icon: "border-[#fb923c]/35 bg-[#fb923c]/15 text-[#fdba74]",
  },
  queue: {
    card: "hover:border-[#a78bfa]/25",
    icon: "border-[#a78bfa]/35 bg-[#a78bfa]/15 text-[#c4b5fd]",
  },
  callbacks: {
    card: "hover:border-[#f97316]/25",
    icon: "border-[#f97316]/35 bg-[#f97316]/15 text-[#fdba74]",
  },
};
