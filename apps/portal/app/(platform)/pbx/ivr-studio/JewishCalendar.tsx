"use client";

/**
 * The Jewish calendar in the IVR Studio.
 *
 * Ported from the approved mockups
 * (https://claude.ai/code/artifact/65ed6be1-6589-41c9-a4e3-9dc9007bac18) —
 * Option A is the face of the card, Option B (the per-holiday list) is ALWAYS
 * shown beneath it, and Option C is the month view behind the header button.
 *
 * ⛔ Both of those were originally hidden — the list behind a preset a fresh
 * calendar never matches, the calendar behind a footer button next to Save — and
 * Izzy could not find either. A feature that has to be discovered is not built.
 *
 * ⛔⛔ THE ONE UI RULE IZZY WAS EXPLICIT ABOUT: in Yiddish, the WORD changes and
 * the PAGE DOES NOT. A Yiddish holiday name renders in its own `dir="rtl"` span
 * with `unicode-bidi: isolate`; no `dir` attribute goes on any container. Put
 * one on a parent and the whole screen mirrors, which is exactly what he ruled
 * out. `isolate` is the load-bearing half — without it the Hebrew reorders the
 * punctuation and digits beside it, so "Succos — 2 days" renders wrong.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPut } from "../../../../services/apiClient";

type Lang = "en" | "yi";
type Treatment = "open" | "early" | "closed";

interface Community { id: string; label: string; detail: string; latitude: number; longitude: number; timezone: string }
interface Shita { id: string; label: string; detail: string }
interface MohProfileLite { id: string; name: string; type: string }

interface CalendarSettings {
  enabled: boolean;
  communityId: string | null;
  nightfallShita: string;
  candleLightingMinutes: number;
  closeForShabbos: boolean;
  closeForYomTov: boolean;
  earlyCloseMinutesBeforeCandles: number;
  reopenMinutesAfterNightfall: number;
  reopenNextMorning: boolean;
  cholHamoed: Treatment;
  fastDays: Treatment;
  holidayOverrides: Record<string, Treatment>;
  sefirah: "none" | "early" | "late" | "whole";
  threeWeeksNoMusic: boolean;
  nineDaysNoMusic: boolean;
  acappellaMohProfileId: string | null;
}

interface LoadResponse {
  calendar: CalendarSettings;
  communities: Community[];
  nightfallShitos: Shita[];
  mohProfiles: MohProfileLite[];
  tableCoverage: { range: [string, string]; daysRemaining: number };
  rightNow: { closed: boolean; reason: string; noMusic: boolean; noMusicReason: string | null; nextChangeAt: string | null; nextChangeWhat: string | null };
}

interface CalendarDay {
  date: string; dayOfWeek: number; holidayKey: string | null; label: string | null;
  kind: string | null; treatment: Treatment; verdict: string;
  candleLighting: string | null; nightfall: string | null;
  noMusic: boolean; noMusicReason: string | null; isToday: boolean;
}

interface HolidaySpan {
  key: string; label: string; kind: string; firstDay: string; lastDay: string; dayCount: number;
  startsAt: string | null; endsAt: string | null; treatment: Treatment; overridden: boolean; note: string | null;
}

// ── the no-flip rule, in one place ───────────────────────────────────────────
/**
 * A holiday name. Hebrew script gets its own RTL island; everything around it
 * stays left-to-right.
 *
 * ⛔ Never lift this `dir` onto a row, a cell or the card. That mirrors the page.
 */
function HolidayName({ children }: { children: string }) {
  const hebrew = /[֐-׿]/.test(children);
  if (!hebrew) return <>{children}</>;
  return <span className="jc-he" dir="rtl">{children}</span>;
}

const LANG_KEY = "cc-holiday-name-lang";
const fmtTime = (iso: string | null, tz: string) => {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
      .replace(/\s/, "").toLowerCase();
  } catch { return null; }
};
const fmtDay = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
};
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Which preset the current settings correspond to. */
function presetOf(s: CalendarSettings): "standard" | "yomtov" | "custom" {
  if (Object.keys(s.holidayOverrides || {}).length > 0) return "custom";
  if (s.closeForShabbos && s.closeForYomTov && s.earlyCloseMinutesBeforeCandles > 0) return "standard";
  if (!s.closeForShabbos && s.closeForYomTov) return "yomtov";
  return "custom";
}

export function JewishCalendarCard({ tenantId, disabled, onSaved }: {
  tenantId: string | null;
  disabled?: boolean;
  onSaved?: () => void;
}) {
  const [data, setData] = useState<LoadResponse | null>(null);
  const [draft, setDraft] = useState<CalendarSettings | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);

  const [lang, setLang] = useState<Lang>("en");

  useEffect(() => {
    try { const v = window.localStorage.getItem(LANG_KEY); if (v === "yi" || v === "en") setLang(v); } catch { /* private mode */ }
  }, []);
  const pickLang = (l: Lang) => {
    setLang(l);
    try { window.localStorage.setItem(LANG_KEY, l); } catch { /* private mode */ }
  };

  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  const load = useCallback(async () => {
    if (!tenantId) return;
    setErr(null);
    try {
      const r = await apiGet<LoadResponse>(`/voice/jewish-calendar${qs}`);
      setData(r);
      setDraft(r.calendar);
      setSaved(JSON.stringify(r.calendar));

    } catch (e: any) {
      setErr(e?.body?.detail || e?.message || "Could not load the Jewish calendar.");
    }
  }, [tenantId, qs]);
  useEffect(() => { void load(); }, [load]);

  const changed = draft ? JSON.stringify(draft) !== saved : false;
  const set = <K extends keyof CalendarSettings>(k: K, v: CalendarSettings[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const applyPreset = (p: "standard" | "yomtov" | "custom") => {
    if (p === "standard") setDraft((d) => d && ({ ...d, closeForShabbos: true, closeForYomTov: true, earlyCloseMinutesBeforeCandles: d.earlyCloseMinutesBeforeCandles || 60, cholHamoed: "open", holidayOverrides: {} }));
    else if (p === "yomtov") setDraft((d) => d && ({ ...d, closeForShabbos: false, closeForYomTov: true, holidayOverrides: {} }));
  };

  async function save() {
    if (!draft || !tenantId) return;
    setBusy(true); setErr(null);
    try {
      await apiPut(`/voice/jewish-calendar`, { ...draft, tenantId });
      await load();
      onSaved?.();
    } catch (e: any) {
      setErr(e?.body?.detail || e?.message || "Could not save.");
    } finally { setBusy(false); }
  }

  if (!tenantId) return null;
  if (!data || !draft) {
    return (
      <div className="card">
        <div className="card-h"><div><h2>Jewish calendar</h2><div className="sub">{err ?? "Loading…"}</div></div></div>
      </div>
    );
  }

  const preset = presetOf(draft);
  const community = data.communities.find((c) => c.id === draft.communityId) ?? null;
  const tz = community?.timezone ?? "America/New_York";
  const now = data.rightNow;

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h2>Jewish calendar</h2>
          <div className="sub">
            {draft.enabled
              ? "Closed for yom tov and Shabbos — set once, right every year"
              : "Off — the phone follows your weekly hours only"}
          </div>
        </div>
        <div className="jc-headright">
          {/* ⛔ This button lives in the HEADER on purpose. It was in the footer
              next to Save, where it read as an afterthought and Izzy did not
              find it — he asked for "a button where people can see the calendar
              month by month", so it has to look like one. */}
          <button type="button" className="btn primary jc-calbtn" onClick={() => setShowCalendar(true)}>
            📅 See the calendar
          </button>
          <div className="jc-seg" role="group" aria-label="Holiday name language">
            <button type="button" className={"jc-segbtn" + (lang === "en" ? " on" : "")} onClick={() => pickLang("en")}>English</button>
            <button type="button" className={"jc-segbtn jc-segyi" + (lang === "yi" ? " on" : "")} onClick={() => pickLang("yi")} lang="yi" dir="rtl">אידיש</button>
          </div>
          <label className="jc-toggle">
            <input type="checkbox" disabled={disabled} checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            <span>{draft.enabled ? "On" : "Off"}</span>
          </label>
        </div>
      </div>

      <div className="card-b">
        {err && <div className="jc-err">{err}</div>}

        {draft.enabled && (
          <div className="jc-strip">
            <span className="pill" style={{ background: now.closed ? "var(--vm)" : "var(--ok)", color: "#fff" }}>
              {now.closed ? "Closed right now" : "Open right now"}
            </span>
            {now.closed && now.reason && <span className="dimtxt">{now.reason}.</span>}
            {now.nextChangeAt && (
              <span className="dimtxt">
                Next change {new Date(now.nextChangeAt).toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" })} — {now.nextChangeWhat}.
              </span>
            )}
            {now.noMusic && <span className="pill jc-pill-music">A cappella — {now.noMusicReason}</span>}
          </div>
        )}

        <div className="jc-row">
          <div className="field">
            <label>Where are you</label>
            <select className="sel" disabled={disabled} value={draft.communityId ?? ""} onChange={(e) => set("communityId", e.target.value || null)}>
              <option value="">Choose your community…</option>
              {data.communities.map((c) => <option key={c.id} value={c.id}>{c.label} — {c.detail}</option>)}
            </select>
            <div className="dimtxt jc-hint">Sets candle lighting and nightfall.</div>
          </div>
          <div className="field">
            <label>Whose times</label>
            <select className="sel" disabled={disabled} value={draft.nightfallShita} onChange={(e) => set("nightfallShita", e.target.value)}>
              {data.nightfallShitos.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <div className="dimtxt jc-hint">
              {data.nightfallShitos.find((s) => s.id === draft.nightfallShita)?.detail}
            </div>
          </div>
        </div>

        <div className="field">
          <label>What the phone should do</label>
          <div className="jc-opts">
            <PresetOption on={preset === "standard"} disabled={disabled} onPick={() => applyPreset("standard")}
              title="Standard — the way most businesses run"
              detail="Closed all yom tov. Closed Shabbos. Closes early erev Shabbos and erev yom tov. Open Chol Hamoed." />
            <PresetOption on={preset === "yomtov"} disabled={disabled} onPick={() => applyPreset("yomtov")}
              title="Yom tov only"
              detail="Closed for yom tov. Shabbos comes from your weekly hours above, as it does today." />
            <PresetOption on={preset === "custom"} disabled={disabled} onPick={() => applyPreset("custom")}
              title="Let me choose holiday by holiday"
              detail="Opens the full list — every holiday with its own setting." />
          </div>
        </div>

        <div className="jc-row">
          <div className="field">
            <label>Close early before Shabbos and yom tov</label>
            <select className="sel" disabled={disabled} value={String(draft.earlyCloseMinutesBeforeCandles)}
              onChange={(e) => set("earlyCloseMinutesBeforeCandles", Number(e.target.value))}>
              <option value="0">Don&rsquo;t close early</option>
              <option value="30">30 minutes before candle lighting</option>
              <option value="60">1 hour before candle lighting</option>
              <option value="120">2 hours before candle lighting</option>
            </select>
          </div>
          <div className="field">
            <label>Chol Hamoed</label>
            <select className="sel" disabled={disabled} value={draft.cholHamoed} onChange={(e) => set("cholHamoed", e.target.value as Treatment)}>
              <option value="open">Normal hours</option>
              <option value="early">Reduced hours</option>
              <option value="closed">Closed all day</option>
            </select>
          </div>
          <div className="field">
            <label>Fast days</label>
            <select className="sel" disabled={disabled} value={draft.fastDays} onChange={(e) => set("fastDays", e.target.value as Treatment)}>
              <option value="open">Normal hours</option>
              <option value="early">Reduced hours</option>
              <option value="closed">Closed all day</option>
            </select>
          </div>
        </div>

        {/* ── hold music ───────────────────────────────────────────────────── */}
        <div className="jc-sub">
          <h3>Hold music during Sefirah and the Three Weeks</h3>
          <p className="dimtxt jc-hint">
            Instrumental music switches to a cappella on its own, and switches back after.
            {!draft.acappellaMohProfileId && " Pick a hold-music profile below or nothing changes."}
          </p>
          <div className="jc-row">
            <div className="field">
              <label>Play this instead</label>
              <select className="sel" disabled={disabled} value={draft.acappellaMohProfileId ?? ""}
                onChange={(e) => set("acappellaMohProfileId", e.target.value || null)}>
                <option value="">Leave the hold music alone</option>
                {data.mohProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Sefirah</label>
              <select className="sel" disabled={disabled} value={draft.sefirah} onChange={(e) => set("sefirah", e.target.value as CalendarSettings["sefirah"])}>
                <option value="early">Pesach until Lag BaOmer</option>
                <option value="late">Rosh Chodesh Iyar until Shavuos</option>
                <option value="whole">The whole Sefirah</option>
                <option value="none">Music all through Sefirah</option>
              </select>
            </div>
          </div>
          <div className="jc-checks">
            <label className="jc-check">
              <input type="checkbox" disabled={disabled} checked={draft.threeWeeksNoMusic} onChange={(e) => set("threeWeeksNoMusic", e.target.checked)} />
              <span>The Three Weeks</span>
            </label>
            <label className="jc-check">
              <input type="checkbox" disabled={disabled} checked={draft.nineDaysNoMusic} onChange={(e) => set("nineDaysNoMusic", e.target.checked)} />
              <span>The Nine Days</span>
            </label>
          </div>
        </div>

        {/* ⛔ ALWAYS rendered. This was gated on the "choose holiday by holiday"
            preset, which a fresh calendar never matches — so the per-holiday
            schedule, the thing that was actually asked for, was invisible. */}
        {(
          <HolidayList tenantId={tenantId} lang={lang} disabled={disabled} tz={tz}
            overrides={draft.holidayOverrides}
            onChange={(key, t) => setDraft((d) => {
              if (!d) return d;
              const next = { ...d.holidayOverrides };
              if (t === null) delete next[key]; else next[key] = t;
              return { ...d, holidayOverrides: next };
            })} />
        )}

        <div className="foot">
          {changed && <span className="pill" style={{ marginRight: "auto" }}>Not saved yet</span>}
          <button className="btn primary" disabled={disabled || busy || !changed} onClick={() => void save()}>
            {busy ? "Saving…" : "Save calendar"}
          </button>
        </div>
      </div>

      {showCalendar && <MonthView tenantId={tenantId} lang={lang} onClose={() => setShowCalendar(false)} />}
    </div>
  );
}

function PresetOption({ on, title, detail, disabled, onPick }: {
  on: boolean; title: string; detail: string; disabled?: boolean; onPick: () => void;
}) {
  return (
    <button type="button" className={"jc-opt" + (on ? " on" : "")} disabled={disabled} onClick={onPick} aria-pressed={on}>
      <span className="jc-dot" aria-hidden="true" />
      <span className="jc-opttext"><b>{title}</b><span>{detail}</span></span>
    </button>
  );
}

// ── Option B: the holiday list ───────────────────────────────────────────────
function HolidayList({ tenantId, lang, disabled, tz, overrides, onChange }: {
  tenantId: string; lang: Lang; disabled?: boolean; tz: string;
  overrides: Record<string, Treatment>;
  onChange: (key: string, treatment: Treatment | null) => void;
}) {
  const [rows, setRows] = useState<HolidaySpan[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await apiGet<{ holidays: HolidaySpan[] }>(
          `/voice/jewish-calendar/holidays?tenantId=${encodeURIComponent(tenantId)}&lang=${lang}`);
        if (live) { setRows(r.holidays); setErr(null); }
      } catch (e: any) {
        if (live) setErr(e?.body?.detail || e?.message || "Could not load the holidays.");
      }
    })();
    return () => { live = false; };
  }, [tenantId, lang]);

  if (err) return <div className="jc-err">{err}</div>;
  if (!rows) return <div className="dimtxt jc-hint">Loading the year ahead…</div>;

  return (
    <div className="jc-sub">
      <h3>A schedule for each holiday</h3>
      <p className="dimtxt jc-hint">
        Set against the holiday, not the date — it applies every year and the dates move on their own.
      </p>
      <div className="jc-hlist">
        {rows.map((h) => {
          const current: Treatment = overrides[h.key] ?? h.treatment;
          return (
            <div key={`${h.key}-${h.firstDay}`} className={"jc-hrow jc-stripe-" + (h.kind === "yomtov" ? "yt" : h.kind === "cholhamoed" ? "chm" : "no")}>
              <div className="jc-hname">
                <HolidayName>{h.label}</HolidayName>
                {h.note && <em>{h.note}</em>}
              </div>
              <div className="jc-hwhen">
                {h.startsAt && h.endsAt
                  ? `${fmtDay(h.firstDay)} ${fmtTime(h.startsAt, tz) ?? ""} → ${fmtDay(h.lastDay)} ${fmtTime(h.endsAt, tz) ?? ""}`
                  : h.dayCount > 1 ? `${fmtDay(h.firstDay)} → ${fmtDay(h.lastDay)}` : fmtDay(h.firstDay)}
              </div>
              <select className="sel" disabled={disabled} value={current}
                onChange={(e) => onChange(h.key, e.target.value as Treatment)}>
                <option value="closed">Closed all day</option>
                <option value="early">Reduced hours</option>
                <option value="open">Normal hours</option>
              </select>
              {overrides[h.key] !== undefined
                ? <button type="button" className="btn sm" disabled={disabled} onClick={() => onChange(h.key, null)}>Reset</button>
                : <span className="dimtxt jc-auto">automatic</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Option C: the month view ─────────────────────────────────────────────────
function MonthView({ tenantId, lang, onClose }: { tenantId: string; lang: Lang; onClose: () => void }) {
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [payload, setPayload] = useState<{ days: CalendarDay[]; timezone: string; today: string; previewOnly: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await apiGet<{ days: CalendarDay[]; timezone: string; today: string; previewOnly: boolean }>(
          `/voice/jewish-calendar/month?tenantId=${encodeURIComponent(tenantId)}&year=${year}&month=${month}&lang=${lang}`);
        if (!live) return;
        setPayload(r); setErr(null);
        setSelected((s) => (s && r.days.some((d) => d.date === s) ? s : (r.days.find((d) => d.isToday)?.date ?? r.days[0]?.date ?? null)));
      } catch (e: any) {
        if (live) setErr(e?.body?.detail || e?.message || "Could not load the calendar.");
      }
    })();
    return () => { live = false; };
  }, [tenantId, year, month, lang]);

  const step = (delta: number) => {
    const m = month + delta;
    if (m < 1) { setMonth(12); setYear((y) => y - 1); }
    else if (m > 12) { setMonth(1); setYear((y) => y + 1); }
    else setMonth(m);
  };

  const days = payload?.days ?? [];
  const tz = payload?.timezone ?? "America/New_York";
  const sel = days.find((d) => d.date === selected) ?? null;
  const closedCount = days.filter((d) => d.treatment === "closed").length;

  return (
    <div className="jc-modal" role="dialog" aria-modal="true" aria-label="Your phone calendar">
      <div className="jc-backdrop" onClick={onClose} />
      <div className="jc-sheet">
        <div className="jc-sheeth">
          <div>
            <h3>Your phone calendar</h3>
            <div className="dimtxt">American Jewish calendar — what the phone will do on each day</div>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        <div className="jc-sheetb">
          {err && <div className="jc-err">{err}</div>}
          {payload?.previewOnly && (
            <div className="jc-preview">This is a preview — the Jewish calendar is switched off, so it is not driving your phone yet.</div>
          )}

          <div className="jc-calbar">
            <button className="btn sm" onClick={() => step(-1)} aria-label="Previous month">←</button>
            <button className="btn sm" onClick={() => step(1)} aria-label="Next month">→</button>
            <div className="jc-mo">{MONTH_NAMES[month - 1]} {year}</div>
            <button className="btn sm" onClick={() => { setYear(today.getFullYear()); setMonth(today.getMonth() + 1); }}>Today</button>
            <span className="jc-spacer" />
            <span className="pill">{closedCount} closed {closedCount === 1 ? "day" : "days"} this month</span>
          </div>

          <div className="jc-scrollx">
            <div className="jc-grid">
              {DOW_SHORT.map((n) => <div key={n} className="jc-dow">{n}</div>)}
              {days.length > 0 && Array.from({ length: days[0].dayOfWeek }).map((_, i) => <div key={`b${i}`} className="jc-cell jc-blank" />)}
              {days.map((d) => {
                const tone = d.treatment === "closed" ? (d.kind === "shabbos" ? "sh" : "yt")
                  : d.treatment === "early" ? "er" : d.kind === "cholhamoed" ? "chm" : "";
                const cl = fmtTime(d.candleLighting, tz);
                const nf = fmtTime(d.nightfall, tz);
                return (
                  <button key={d.date} type="button"
                    className={`jc-cell ${tone ? "jc-" + tone : ""} ${d.date === selected ? "jc-sel" : ""} ${d.isToday ? "jc-today" : ""}`}
                    onClick={() => setSelected(d.date)}
                    aria-label={`${d.date} ${d.verdict}`}>
                    <span className="jc-gd">{Number(d.date.slice(8))}</span>
                    {d.label && <span className="jc-lb"><HolidayName>{d.label}</HolidayName></span>}
                    {d.noMusic && <span className="jc-music" title={d.noMusicReason ?? ""}>♪</span>}
                    <span className="jc-tm">{cl ? `⚑ ${cl}` : nf ? `★ ${nf}` : ""}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="jc-legend">
            <span><i className="jc-sw-yt" />Closed — yom tov</span>
            <span><i className="jc-sw-sh" />Shabbos</span>
            <span><i className="jc-sw-er" />Closes early</span>
            <span><i className="jc-sw-chm" />Chol Hamoed</span>
            <span><i className="jc-sw-no" />Normal hours</span>
            <span>♪ a cappella</span>
          </div>

          {sel && (
            <div className="jc-day">
              <h4>{DOW_SHORT[sel.dayOfWeek]}, {fmtDay(sel.date)} {sel.date.slice(0, 4)}</h4>
              {sel.label && <div className="dimtxt"><HolidayName>{sel.label}</HolidayName></div>}
              <div className="jc-verdict">{sel.verdict}</div>
              <div className="dimtxt">
                {fmtTime(sel.candleLighting, tz) && <>Candle lighting <b>{fmtTime(sel.candleLighting, tz)}</b>. </>}
                {fmtTime(sel.nightfall, tz) && <>Nightfall <b>{fmtTime(sel.nightfall, tz)}</b>. </>}
                {sel.noMusic && <>Hold music is a cappella — {sel.noMusicReason}.</>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
