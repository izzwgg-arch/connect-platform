"use client";

// ── IVR Studio ───────────────────────────────────────────────────────────────
// Practical, key-by-key IVR builder that mirrors the way VitalPBX sets up a menu,
// wired end-to-end to the Connect IVR APIs (route-profiles, per-digit options,
// tenant recordings, publish). Replaces the old /pbx/ivr-routing table UI.
// Every control here calls a real endpoint — no dead buttons.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, getPortalApiBaseUrl } from "../../../../services/apiClient";
import {
  type DestinationType, DESTINATION_TYPES, DESTINATION_TYPE_LABELS,
  OPTION_DIGIT_ORDER, DIGIT_GLYPH, DIGIT_SUBLABEL,
  type ExtensionSuggestion, type NumberSuggestion,
  parseDestinationRef, buildDestinationRef, validateDestinationRef, describeDestination,
  tenantDialContextFromSuggestions,
} from "./ivrStudioLib";

interface RouteProfile {
  id: string; tenantId: string; name: string; type: string;
  pbxPromptRef: string | null; pbxInvalidPromptRef: string | null; pbxTimeoutPromptRef: string | null;
  timeoutSeconds: number; maxRetries: number; directDialEnabled: boolean;
  invalidDestinationType: DestinationType | null; invalidDestinationRef: string | null;
  timeoutDestinationType: DestinationType | null; timeoutDestinationRef: string | null;
  isActive: boolean;
}
interface OptionRow {
  id: string; profileId: string; optionDigit: string;
  destinationType: DestinationType; destinationRef: string; label: string | null; enabled: boolean;
}
interface PromptRow { id: string; promptRef: string; displayName: string; category: string; hasAudio?: boolean }
interface ScheduleRow {
  timezone: string;
  businessHoursRules: Array<{ day: number; open: string; close: string }>;
  holidayDates: string[];
  defaultProfileId: string | null;
  afterHoursProfileId: string | null;
  holidayProfileId: string | null;
  isActive: boolean;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Kept short on purpose — these are the zones Connect's tenants actually sit
// in. A free-text zone would be a support ticket waiting to happen.
const TIMEZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
];
const EMPTY_SCHEDULE: ScheduleRow = {
  timezone: "America/New_York", businessHoursRules: [], holidayDates: [],
  defaultProfileId: null, afterHoursProfileId: null, holidayProfileId: null, isActive: true,
};

// Inline SVG paths per destination type (24x24, stroke). Matches the mockup.
const ICON: Record<DestinationType, string> = {
  extension: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.5-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.6 2.6.7a2 2 0 0 1 1.7 2Z"/>',
  queue: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  ring_group: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  voicemail: '<circle cx="6" cy="14" r="4"/><circle cx="18" cy="14" r="4"/><path d="M6 18h12"/>',
  ivr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  announcement: '<path d="M3 10v4h4l5 5V5L7 10H3ZM16 8a5 5 0 0 1 0 8"/>',
  external_number: '<path d="M2 6a2 2 0 0 1 2-2h4l2 5-3 2a14 14 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 2 6Z"/>',
  terminate: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  custom: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6 2 2 6-6a4 4 0 0 0 5.4-5.4l-2.3 2.3-1.7-1.7Z"/>',
};
function Svg({ type, cls }: { type: DestinationType; cls?: string }) {
  return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} dangerouslySetInnerHTML={{ __html: ICON[type] }} />;
}

export default function IvrStudioPage() {
  const { tenantId, tenant, can } = useAppContext();
  const canManage = can("can_manage_ivr_routing");
  const canPublish = can("can_publish_ivr_routing") || canManage;

  const [profiles, setProfiles] = useState<RouteProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [exts, setExts] = useState<ExtensionSuggestion[]>([]);
  const [queues, setQueues] = useState<NumberSuggestion[]>([]);
  const [ringGroups, setRingGroups] = useState<NumberSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // digit being edited
  const [recPickerFor, setRecPickerFor] = useState<null | "greeting">(null);
  const [schedule, setSchedule] = useState<ScheduleRow | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const active = useMemo(() => profiles.find((p) => p.id === activeId) ?? null, [profiles, activeId]);
  const tenantDialContext = useMemo(() => tenantDialContextFromSuggestions(exts), [exts]);
  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  const streamUrl = useCallback((promptId: string) => {
    const base = getPortalApiBaseUrl();
    const token = (typeof window !== "undefined" && (localStorage.getItem("token") || localStorage.getItem("cc-token"))) || "";
    return `${base}/voice/ivr/prompts/${encodeURIComponent(promptId)}/stream?token=${encodeURIComponent(token)}`;
  }, []);

  const play = useCallback((promptRef: string | null | undefined) => {
    if (!promptRef) { flash("No recording set"); return; }
    const row = prompts.find((p) => p.promptRef === promptRef);
    if (!row) { flash("Recording not in library"); return; }
    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = streamUrl(row.id);
    audioRef.current.play().catch(() => flash("Couldn't play — upload audio first"));
  }, [prompts, streamUrl]);

  const loadProfiles = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true); setError(null);
    try {
      const [p, pr, sc] = await Promise.all([
        apiGet<{ profiles: RouteProfile[] }>(`/voice/ivr/route-profiles${qs}`),
        apiGet<{ prompts: PromptRow[] }>(`/voice/ivr/prompts${qs}`),
        // A tenant with no hours set yet is normal, not an error — the card
        // renders in its "always open" state and saving creates the row.
        apiGet<{ schedule: ScheduleRow | null }>(`/voice/ivr/schedule${qs}`).catch(() => ({ schedule: null })),
      ]);
      const list = p.profiles || [];
      setProfiles(list);
      setPrompts(pr.prompts || []);
      setSchedule(sc.schedule ? { ...EMPTY_SCHEDULE, ...sc.schedule } : null);
      setActiveId((cur) => cur && list.some((x) => x.id === cur) ? cur : (list.find((x) => x.isActive)?.id ?? list[0]?.id ?? null));
    } catch (e: any) {
      setError(e?.message || "Couldn't load IVR menus");
    } finally { setLoading(false); }
  }, [tenantId, qs]);

  const loadOptions = useCallback(async (profileId: string) => {
    try {
      const r = await apiGet<{ options: OptionRow[] }>(`/voice/ivr/route-profiles/${profileId}/options${qs}`);
      setOptions(r.options || []);
    } catch { setOptions([]); }
  }, [qs]);

  // Live resource lists for the editor dropdowns (best-effort; free-text fallback).
  useEffect(() => {
    if (!tenantId) return;
    let abort = false;
    (async () => {
      const safe = async <T,>(path: string): Promise<T | null> => { try { return await apiGet<T>(path); } catch { return null; } };
      const [e, q, g] = await Promise.all([
        safe<{ rows: any[] }>(`/voice/pbx/resources/extensions?tenantId=${encodeURIComponent(tenantId)}`),
        safe<{ rows: any[] }>(`/voice/pbx/resources/queues?tenantId=${encodeURIComponent(tenantId)}`),
        safe<{ rows: any[] }>(`/voice/pbx/ring-groups?tenantId=${encodeURIComponent(tenantId)}`),
      ]);
      if (abort) return;
      setExts((e?.rows || []).map((x) => ({ extension: String(x.extension), name: x.name ?? null, pbxDeviceName: x.pbxDeviceName ?? null, pbxSipUsername: x.pbxSipUsername ?? null })));
      setQueues((q?.rows || []).map((x) => ({ number: String(x.number ?? x.queue_number ?? x.id ?? ""), name: x.name ?? x.description ?? null })).filter((x) => x.number));
      setRingGroups((g?.rows || []).map((x) => ({ number: String(x.number ?? x.group_number ?? x.extension ?? ""), name: x.name ?? x.description ?? null })).filter((x) => x.number));
    })();
    return () => { abort = true; };
  }, [tenantId]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);
  useEffect(() => { if (activeId) loadOptions(activeId); }, [activeId, loadOptions]);

  const optionByDigit = useMemo(() => {
    const m = new Map<string, OptionRow>();
    for (const o of options) m.set(o.optionDigit, o);
    return m;
  }, [options]);
  const inUse = options.length;

  async function patchProfile(patch: Record<string, unknown>) {
    if (!active) return;
    setSaving(true);
    try {
      await apiPatch(`/voice/ivr/route-profiles/${active.id}${qs}`, patch);
      setProfiles((ps) => ps.map((p) => p.id === active.id ? { ...p, ...patch } as RouteProfile : p));
      setDirty(true); flash("Saved");
    } catch (e: any) { setError(e?.message || "Save failed"); } finally { setSaving(false); }
  }

  async function saveOption(digit: string, next: { type: DestinationType; ref: string; label: string | null }) {
    if (!active) return;
    const err = validateDestinationRef(next.type, next.ref);
    if (err) { flash(err); return; }
    setSaving(true);
    try {
      const existing = optionByDigit.get(digit);
      if (existing) {
        const r = await apiPatch<{ option: OptionRow }>(`/voice/ivr/route-profiles/${active.id}/options/${existing.id}${qs}`, { destinationType: next.type, destinationRef: next.ref, label: next.label });
        setOptions((os) => os.map((o) => o.id === existing.id ? r.option : o));
      } else {
        const r = await apiPost<{ option: OptionRow }>(`/voice/ivr/route-profiles/${active.id}/options${qs}`, { optionDigit: digit, destinationType: next.type, destinationRef: next.ref, label: next.label });
        setOptions((os) => [...os, r.option]);
      }
      setDirty(true); setSelected(null); flash(`Key ${DIGIT_GLYPH[digit] ?? digit} saved`);
    } catch (e: any) { setError(e?.message || "Couldn't save that key"); } finally { setSaving(false); }
  }

  async function clearOption(digit: string) {
    if (!active) return;
    const existing = optionByDigit.get(digit);
    if (!existing) { setSelected(null); return; }
    setSaving(true);
    try {
      await apiDelete(`/voice/ivr/route-profiles/${active.id}/options/${existing.id}${qs}`);
      setOptions((os) => os.filter((o) => o.id !== existing.id));
      setDirty(true); setSelected(null); flash(`Key ${DIGIT_GLYPH[digit] ?? digit} cleared`);
    } catch (e: any) { setError(e?.message || "Couldn't clear that key"); } finally { setSaving(false); }
  }

  // Create a menu. `type` matters: "after_hours" is the menu the hours card
  // plays when the tenant is closed, so creating one here is what makes the
  // after-hours picker useful.
  async function createProfile(type: "business_hours" | "after_hours") {
    if (!tenantId) return;
    const suggested = type === "after_hours" ? "After hours" : "New menu";
    const name = (typeof window !== "undefined" ? window.prompt("Name this menu", suggested) : suggested)?.trim();
    if (!name) return;
    setSaving(true);
    try {
      const r = await apiPost<{ profile: RouteProfile }>(`/voice/ivr/route-profiles${qs}`, { tenantId, name, type });
      setProfiles((ps) => [...ps, r.profile]);
      setActiveId(r.profile.id);
      setSelected(null);
      setDirty(true);
      flash(`"${name}" created`);
      // A brand-new after-hours menu is only useful once the hours card knows
      // about it — wire it up straight away rather than making that a second,
      // easily-forgotten step.
      if (type === "after_hours") {
        const next = { ...(schedule ?? EMPTY_SCHEDULE), afterHoursProfileId: r.profile.id };
        setSchedule(next);
        await saveSchedule(next);
      }
    } catch (e: any) { setError(e?.message || "Couldn't create that menu"); } finally { setSaving(false); }
  }

  async function saveSchedule(next: ScheduleRow) {
    if (!tenantId) return;
    setSaving(true);
    try {
      await apiPut(`/voice/ivr/schedule`, { ...next, tenantId });
      setSchedule(next);
      setDirty(true);
      flash("Hours saved");
    } catch (e: any) { setError(e?.message || "Couldn't save the hours"); } finally { setSaving(false); }
  }

  async function publish() {
    if (!active) return;
    setSaving(true);
    try {
      await apiPost(`/voice/ivr/publish${qs}`, { profileId: active.id });
      setDirty(false); flash("Published — live now");
    } catch (e: any) { setError(e?.message || "Publish failed"); } finally { setSaving(false); }
  }

  function toggleTheme() {
    const root = document.documentElement;
    const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    root.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
  }

  const greetingRow = prompts.find((p) => p.promptRef === active?.pbxPromptRef);

  return (
    <div className="ivrs">
      <StudioStyles />

      {/* command bar */}
      <div className="bar">
        <div className="brand"><span className="logo">C</span>Connect</div>
        <div className="crumbs">PBX <span>›</span> IVR Studio <span>›</span> <b>{active?.name ?? "—"}</b></div>
        <div className="spacer" />
        <div className="tenant" title="Current tenant">
          <span className="dot" />
          <div><div style={{ fontWeight: 600, fontSize: 13 }}>{tenant?.name ?? "—"}</div><div className="car">{profiles.length} menu{profiles.length === 1 ? "" : "s"}</div></div>
        </div>
        <button className="btn ghost iconbtn" onClick={toggleTheme} title="Toggle light / dark" aria-label="Toggle theme">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6 6 4.5 4.5M19.5 19.5 18 18M18 6l1.5-1.5M4.5 19.5 6 18" /><circle cx="12" cy="12" r="4" /></svg>
        </button>
      </div>

      {/* title */}
      <div className="titlerow">
        <div>
          <div className="eyebrow" style={{ marginBottom: 9 }}>IVR Studio · Phone Menu</div>
          <div className="name-edit">
            <select className="name-select" value={activeId ?? ""} onChange={(e) => { setSelected(null); setActiveId(e.target.value || null); }}>
              {profiles.length === 0 && <option value="">No menus yet</option>}
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.type === "after_hours" ? " · after hours" : ""}</option>)}
            </select>
            <button className="btn ghost" disabled={!canManage || saving} onClick={() => createProfile("business_hours")} title="Create another menu">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 5v14M5 12h14" /></svg>Add menu
            </button>
          </div>
          <p>Build the menu callers hear, key by key. Everything here goes live the moment you publish — no rebuilds, no downtime.</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {dirty && <span className="status-pill status-draft"><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--warning)", display: "inline-block" }} />Unpublished changes</span>}
          <button className="btn primary" disabled={!canPublish || saving || !active} onClick={publish}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M5 12h14M12 5l7 7-7 7" /></svg>Publish
          </button>
        </div>
      </div>

      {error && <div className="banner err">{error}<button onClick={() => setError(null)}>×</button></div>}
      {loading && <div className="banner">Loading…</div>}
      {!loading && profiles.length === 0 && <div className="banner">This tenant has no IVR menus yet.</div>}

      <div className="grid">
        {/* LEFT: builder */}
        <div>
          {/* greeting */}
          <div className="card">
            <div className="card-h">
              <div className="ix"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M3 10v4h4l5 5V5L7 10H3ZM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14" /></svg></div>
              <div><h2>Greeting</h2><div className="sub">The recording callers hear first</div></div>
            </div>
            <div className="card-b">
              <div className="rec">
                <button className="play" aria-label="Play greeting" onClick={() => play(active?.pbxPromptRef)}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                </button>
                <div className="wave">{Array.from({ length: 44 }).map((_, i) => <i key={i} style={{ height: 16 + Math.abs(Math.sin(i * 0.6)) * 14 + ((i * 13) % 9) }} />)}</div>
                <div className="meta"><b>{greetingRow?.displayName ?? active?.pbxPromptRef ?? "No greeting set"}</b><span>{greetingRow ? "synced from VitalPBX" : "pick one from your library"}</span></div>
                <button className="btn ghost swap" disabled={!canManage} onClick={() => setRecPickerFor(recPickerFor ? null : "greeting")}>Change</button>
              </div>
              {recPickerFor === "greeting" && (
                <div className="reclist" style={{ marginTop: 12 }}>
                  {prompts.length === 0 && <div className="emptxt">No recordings synced for this tenant yet.</div>}
                  {prompts.map((r) => (
                    <div key={r.id} className="recrow" onClick={() => { patchProfile({ pbxPromptRef: r.promptRef }); setRecPickerFor(null); }}>
                      <button className="p" onClick={(e) => { e.stopPropagation(); play(r.promptRef); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg></button>
                      <div className="nm"><b>{r.displayName}</b><span>{r.category}</span></div>
                      {active?.pbxPromptRef === r.promptRef && <span className="len">current</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="legend"><span><i style={{ background: "var(--accent)" }} />Pulled live from this tenant&apos;s VitalPBX recordings — pick one and it just works.</span></div>
            </div>
          </div>

          {/* keypad */}
          <div className="card">
            <div className="card-h">
              <div className="ix"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg></div>
              <div><h2>Menu keys</h2><div className="sub">What each pressed digit does</div></div>
              <div style={{ marginLeft: "auto" }} className="pill-mini">{inUse} of 12 in use</div>
            </div>
            <div className="card-b">
              <div className="kp-help">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg>
                Click any key to set where it sends the caller.
              </div>
              <div className="keypad">
                {OPTION_DIGIT_ORDER.map((digit) => {
                  const o = optionByDigit.get(digit);
                  const glyph = DIGIT_GLYPH[digit] ?? digit;
                  const cls = "key" + (!o ? " empty" : o.destinationType === "terminate" ? " k-term" : o.destinationType === "extension" ? " k-ext" : "") + (selected === digit ? " sel" : "");
                  return (
                    <button key={digit} className={cls} onClick={() => setSelected(selected === digit ? null : digit)}>
                      <span className="tag">{o ? DESTINATION_TYPE_LABELS[o.destinationType] : "empty"}</span>
                      <span className="num">{glyph}{DIGIT_SUBLABEL[digit] && <span className="g">{DIGIT_SUBLABEL[digit]}</span>}</span>
                      {o
                        ? <div className="dest"><span className="ic"><Svg type={o.destinationType} /></span><span className="tx">{describeDestination(o.destinationType, o.destinationRef, o.label)}</span></div>
                        : <div className="dest">+ Assign a destination</div>}
                    </button>
                  );
                })}
              </div>
              {selected && active && (
                <KeyEditor
                  key={selected}
                  digit={selected}
                  current={optionByDigit.get(selected) ?? null}
                  exts={exts} queues={queues} ringGroups={ringGroups} prompts={prompts} profiles={profiles}
                  tenantDialContext={tenantDialContext}
                  disabled={!canManage || saving}
                  onClose={() => setSelected(null)}
                  onClear={() => clearOption(selected)}
                  onSave={(next) => saveOption(selected, next)}
                />
              )}
            </div>
          </div>

          {/* fallback */}
          <div className="card">
            <div className="card-h">
              <div className="ix"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 8v4l3 2M12 3a9 9 0 1 0 9 9" /><path d="M12 3a9 9 0 0 0-7 3.3" /></svg></div>
              <div><h2>If the caller doesn&apos;t choose</h2><div className="sub">Timeout &amp; wrong-key handling — in plain terms</div></div>
            </div>
            <div className="card-b">
              <div className="fb">
                <div className="fbx">
                  <h3><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>Nobody presses anything</h3>
                  <p>They stay silent through the menu.</p>
                  <div className="rowmini">
                    <div className="field"><label>Wait</label>
                      <select className="sel" disabled={!canManage} value={active?.timeoutSeconds ?? 7} onChange={(e) => patchProfile({ timeoutSeconds: Number(e.target.value) })}>
                        {[3, 5, 7, 10, 15].map((s) => <option key={s} value={s}>{s} seconds</option>)}
                      </select>
                    </div>
                    <div className="field"><label>Retries</label>
                      <select className="sel" disabled={!canManage} value={active?.maxRetries ?? 3} onChange={(e) => patchProfile({ maxRetries: Number(e.target.value) })}>
                        {[1, 2, 3, 4].map((s) => <option key={s} value={s}>{s} time{s === 1 ? "" : "s"}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="field"><label>Then send them to</label>
                    <FallbackDest
                      disabled={!canManage}
                      value={{ type: active?.timeoutDestinationType ?? "", ref: active?.timeoutDestinationRef ?? "" }}
                      exts={exts} queues={queues} ringGroups={ringGroups} tenantDialContext={tenantDialContext}
                      onChange={(v) => patchProfile({ timeoutDestinationType: v.type || null, timeoutDestinationRef: v.ref || null })}
                    />
                  </div>
                </div>
                <div className="fbx">
                  <h3><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></svg>They press a wrong key</h3>
                  <p>A digit with nothing assigned.</p>
                  <div className="field"><label>Play</label>
                    <select className="sel" disabled={!canManage} value={active?.pbxInvalidPromptRef ?? ""} onChange={(e) => patchProfile({ pbxInvalidPromptRef: e.target.value || null })}>
                      <option value="">Default prompt</option>
                      {prompts.map((p) => <option key={p.id} value={p.promptRef}>{p.displayName}</option>)}
                    </select>
                  </div>
                  <div className="field"><label>After retries, send them to</label>
                    <FallbackDest
                      disabled={!canManage}
                      value={{ type: active?.invalidDestinationType ?? "", ref: active?.invalidDestinationRef ?? "" }}
                      exts={exts} queues={queues} ringGroups={ringGroups} tenantDialContext={tenantDialContext}
                      onChange={(v) => patchProfile({ invalidDestinationType: v.type || null, invalidDestinationRef: v.ref || null })}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* opening hours + after-hours menu */}
          <HoursCard
            schedule={schedule}
            profiles={profiles}
            disabled={!canManage || saving}
            onSave={saveSchedule}
            onCreateAfterHours={() => createProfile("after_hours")}
          />
        </div>

        {/* RIGHT: live flow + recordings */}
        <div className="sticky">
          <div className="card">
            <div className="card-h">
              <div className="ix"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M9 18V5l12-2v13M9 9l12-2M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" /></svg></div>
              <div><h2>Call flow</h2><div className="sub">Exactly what a caller experiences</div></div>
            </div>
            <div className="card-b">
              <div className="flow">
                <FlowStep icon='<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.5-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.6 2.6.7a2 2 0 0 1 1.7 2Z"/>' t="Caller reaches this menu" d={`${tenant?.name ?? "This tenant"}'s numbers`} />
                <FlowStep icon='<path d="M3 10v4h4l5 5V5L7 10H3Z"/>' t={`Hears "${greetingRow?.displayName ?? active?.pbxPromptRef ?? "greeting"}"`} d="Then the menu options" chip={active?.pbxPromptRef ? "synced recording" : "default greeting"} />
                {options.slice(0, 4).map((o) => (
                  <FlowStep key={o.id} node={DIGIT_GLYPH[o.optionDigit] ?? o.optionDigit}
                    t={`Presses ${DIGIT_GLYPH[o.optionDigit] ?? o.optionDigit}`} d={describeDestination(o.destinationType, o.destinationRef, o.label)}
                    chipType={o.destinationType} />
                ))}
                <FlowStep term icon='<path d="M20 10c0-3-4-5-8-5s-8 2-8 5v2l3 1v-2a10 10 0 0 1 10 0v2l3-1Z"/>' t="Connected" d="Or holds with your chosen music" last />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <div className="ix"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg></div>
              <div><h2>Recordings</h2><div className="sub">This tenant&apos;s VitalPBX library</div></div>
            </div>
            <div className="card-b">
              <div className="reclist">
                {prompts.length === 0 && <div className="emptxt">No recordings synced yet.</div>}
                {prompts.map((r) => (
                  <div key={r.id} className="recrow">
                    <button className="p" onClick={() => play(r.promptRef)}><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg></button>
                    <div className="nm"><b>{r.displayName}</b><span>{r.category}</span></div>
                    {r.hasAudio === false && <span className="len">no audio</span>}
                  </div>
                ))}
              </div>
              <div className="sync"><span className="d" />Synced with VitalPBX · {prompts.length} recording{prompts.length === 1 ? "" : "s"}</div>
            </div>
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ── opening hours + after-hours menu ─────────────────────────────────────────
// Connect's schedule model holds ONE open/close window per weekday
// (computeCurrentMode does rules.find(r => r.day === dow)), so this editor
// deliberately offers one window per day rather than pretending split shifts
// work and quietly ignoring the second one.
function HoursCard({ schedule, profiles, disabled, onSave, onCreateAfterHours }: {
  schedule: ScheduleRow | null;
  profiles: RouteProfile[];
  disabled?: boolean;
  onSave: (next: ScheduleRow) => void;
  onCreateAfterHours: () => void;
}) {
  const [draft, setDraft] = useState<ScheduleRow>(schedule ?? EMPTY_SCHEDULE);
  const [newHoliday, setNewHoliday] = useState("");
  const savedJson = useRef<string>(JSON.stringify(schedule ?? EMPTY_SCHEDULE));

  // Re-seed when the tenant's schedule finishes loading (or the tenant
  // changes), but never clobber edits the operator is midway through.
  useEffect(() => {
    const incoming = JSON.stringify(schedule ?? EMPTY_SCHEDULE);
    if (incoming !== savedJson.current) {
      savedJson.current = incoming;
      setDraft(schedule ?? EMPTY_SCHEDULE);
    }
  }, [schedule]);

  const changed = JSON.stringify(draft) !== savedJson.current;
  const ruleFor = (day: number) => draft.businessHoursRules.find((r) => r.day === day) ?? null;

  const setDay = (day: number, open: string | null, close?: string) => {
    setDraft((d) => {
      const rest = d.businessHoursRules.filter((r) => r.day !== day);
      if (open === null) return { ...d, businessHoursRules: rest.sort((a, b) => a.day - b.day) };
      const existing = d.businessHoursRules.find((r) => r.day === day);
      const next = { day, open, close: close ?? existing?.close ?? "17:00" };
      return { ...d, businessHoursRules: [...rest, next].sort((a, b) => a.day - b.day) };
    });
  };

  const openCount = draft.businessHoursRules.length;

  return (
    <div className="card">
      <div className="card-h">
        <div className="ix"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></div>
        <div><h2>Opening hours</h2><div className="sub">When to play this menu, and what to play when you&apos;re closed</div></div>
        <div style={{ marginLeft: "auto" }} className="pill-mini">{openCount === 0 ? "no hours set" : `open ${openCount} day${openCount === 1 ? "" : "s"}`}</div>
      </div>
      <div className="card-b">
        {openCount === 0 && (
          <div className="kp-help" style={{ marginBottom: 14 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg>
            No opening hours yet — every caller gets the after-hours menu, around the clock. Tick the days you&apos;re open below.
          </div>
        )}

        <div className="rowmini" style={{ marginBottom: 14 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Time zone</label>
            <select className="sel" disabled={disabled} value={draft.timezone} onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz.split("/")[1].replace(/_/g, " ")}</option>)}
              {!TIMEZONES.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}
            </select>
          </div>
        </div>

        <div className="days">
          {DAY_NAMES.map((name, day) => {
            const rule = ruleFor(day);
            return (
              <div key={day} className={"dayrow" + (rule ? "" : " closed")}>
                <label className="daytoggle">
                  <input type="checkbox" disabled={disabled} checked={!!rule}
                    onChange={(e) => setDay(day, e.target.checked ? "09:00" : null, e.target.checked ? "17:00" : undefined)} />
                  <span>{name}</span>
                </label>
                {rule ? (
                  <div className="daytimes">
                    <input className="inp time" type="time" disabled={disabled} value={rule.open} onChange={(e) => setDay(day, e.target.value, rule.close)} />
                    <span className="to">to</span>
                    <input className="inp time" type="time" disabled={disabled} value={rule.close} onChange={(e) => setDay(day, rule.open, e.target.value)} />
                  </div>
                ) : <div className="daytimes closedtxt">Closed all day</div>}
              </div>
            );
          })}
        </div>

        <div className="fb" style={{ marginTop: 16 }}>
          <div className="fbx">
            <h3><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path d="m9 12 2 2 4-4" /></svg>While you&apos;re open</h3>
            <p>The menu callers hear during the hours above.</p>
            <select className="sel" disabled={disabled} value={draft.defaultProfileId ?? ""} onChange={(e) => setDraft((d) => ({ ...d, defaultProfileId: e.target.value || null }))}>
              <option value="">Choose a menu…</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="fbx">
            <h3><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth={2}><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 7v5l3 2" /></svg>When you&apos;re closed</h3>
            <p>The menu callers hear outside those hours.</p>
            <select className="sel" disabled={disabled} value={draft.afterHoursProfileId ?? ""} onChange={(e) => setDraft((d) => ({ ...d, afterHoursProfileId: e.target.value || null }))}>
              <option value="">Choose a menu…</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {!profiles.some((p) => p.type === "after_hours") && (
              <button className="btn ghost" style={{ marginTop: 9 }} disabled={disabled} onClick={onCreateAfterHours}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 5v14M5 12h14" /></svg>Add an after-hours menu
              </button>
            )}
          </div>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label>Days you&apos;re closed all day (holidays)</label>
          <div className="holidays">
            {draft.holidayDates.length === 0 && <span className="emptxt">None yet</span>}
            {draft.holidayDates.map((d) => (
              <span key={d} className="hchip">{d}
                <button disabled={disabled} onClick={() => setDraft((s) => ({ ...s, holidayDates: s.holidayDates.filter((x) => x !== d) }))} aria-label={`Remove ${d}`}>×</button>
              </span>
            ))}
          </div>
          <div className="rowmini" style={{ marginTop: 8 }}>
            <input className="inp" type="date" disabled={disabled} value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} />
            <button className="btn ghost" disabled={disabled || !newHoliday || draft.holidayDates.includes(newHoliday)}
              onClick={() => { setDraft((s) => ({ ...s, holidayDates: [...s.holidayDates, newHoliday].sort() })); setNewHoliday(""); }}>Add</button>
          </div>
        </div>

        <div className="foot">
          {changed && <span className="pill-mini" style={{ alignSelf: "center", marginRight: "auto" }}>Not saved yet</span>}
          <button className="btn primary" disabled={disabled || !changed} onClick={() => onSave(draft)}>Save hours</button>
        </div>
      </div>
    </div>
  );
}

// ── inline destination editor (under the keypad) ─────────────────────────────
function KeyEditor({ digit, current, exts, queues, ringGroups, prompts, profiles, tenantDialContext, disabled, onClose, onClear, onSave }: {
  digit: string; current: OptionRow | null;
  exts: ExtensionSuggestion[]; queues: NumberSuggestion[]; ringGroups: NumberSuggestion[]; prompts: PromptRow[]; profiles: RouteProfile[];
  tenantDialContext: string | null; disabled?: boolean;
  onClose: () => void; onClear: () => void; onSave: (next: { type: DestinationType; ref: string; label: string | null }) => void;
}) {
  const [type, setType] = useState<DestinationType>(current?.destinationType ?? "extension");
  const parsed = current ? parseDestinationRef(current.destinationType, current.destinationRef) : { selected: "", free: "" };
  const [selVal, setSelVal] = useState(parsed.selected);
  const [freeVal, setFreeVal] = useState(parsed.free);
  const glyph = DIGIT_GLYPH[digit] ?? digit;

  function refFor(): string {
    if (type === "terminate") return buildDestinationRef("terminate", "", "", {});
    const extensionRow = type === "extension" ? exts.find((e) => e.extension === selVal) : undefined;
    const usesSelect = ["extension", "queue", "ring_group", "voicemail"].includes(type);
    return buildDestinationRef(type, usesSelect ? selVal : "", usesSelect ? "" : freeVal, { extensionRow, tenantDialContext });
  }
  const ref = refFor();
  const err = validateDestinationRef(type, ref);

  const targetControl = () => {
    if (type === "extension") return <select className="sel" value={selVal} onChange={(e) => setSelVal(e.target.value)}><option value="">Choose extension…</option>{exts.map((e) => <option key={e.extension} value={e.extension}>{e.extension}{e.name ? ` · ${e.name}` : ""}</option>)}</select>;
    if (type === "queue") return <select className="sel" value={selVal} onChange={(e) => setSelVal(e.target.value)}><option value="">Choose queue…</option>{queues.map((q) => <option key={q.number} value={q.number}>{q.name ?? q.number}</option>)}</select>;
    if (type === "ring_group") return ringGroups.length ? <select className="sel" value={selVal} onChange={(e) => setSelVal(e.target.value)}><option value="">Choose ring group…</option>{ringGroups.map((g) => <option key={g.number} value={g.number}>{g.name ?? g.number}</option>)}</select> : <input className="inp" placeholder="Ring group number" value={selVal} onChange={(e) => setSelVal(e.target.value)} />;
    if (type === "voicemail") return <select className="sel" value={selVal} onChange={(e) => setSelVal(e.target.value)}><option value="">Choose mailbox…</option>{exts.map((e) => <option key={e.extension} value={e.extension}>{e.extension}{e.name ? ` · ${e.name}` : ""}</option>)}</select>;
    if (type === "announcement") return <input className="inp" placeholder="announcement context,exten,1" value={freeVal} onChange={(e) => setFreeVal(e.target.value)} />;
    if (type === "ivr") return <select className="sel" value={freeVal} onChange={(e) => setFreeVal(e.target.value)}><option value="">Choose sub-menu…</option>{profiles.map((p) => <option key={p.id} value={`connect-tenant-ivr,${p.id},1`}>{p.name}</option>)}</select>;
    if (type === "external_number") return <input className="inp" placeholder="+18455551234" value={freeVal} onChange={(e) => setFreeVal(e.target.value)} />;
    if (type === "terminate") return <div className="pill-mini" style={{ display: "inline-block" }}>Call ends — nothing else to set.</div>;
    return <input className="inp" placeholder="context,exten,priority (allow-listed)" value={freeVal} onChange={(e) => setFreeVal(e.target.value)} />;
  };

  return (
    <div className="editor">
      <div className="editor-h"><span className="kb">{glyph}</span><div><b>When callers press {glyph}</b><br /><span>Choose where it takes them</span></div>
        <button className="btn ghost iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 6 6 18M6 6l12 12" /></svg></button>
      </div>
      <div className="editor-b">
        <div className="eyebrow" style={{ marginBottom: 9 }}>Destination type</div>
        <div className="types">
          {DESTINATION_TYPES.map((t) => (
            <button key={t} className={"type" + (type === t ? " on" : "")} onClick={() => { setType(t); setSelVal(""); setFreeVal(""); }}>
              <Svg type={t} />{DESTINATION_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        {type !== "terminate" && <div className="field"><label>Send the caller to</label>{targetControl()}</div>}
        {type === "terminate" && <div className="field">{targetControl()}</div>}
        {err && type !== "terminate" && (selVal || freeVal) && <div className="hint err">{err}</div>}
        <div className="foot">
          <button className="btn ghost" disabled={disabled} onClick={onClear}>Clear this key</button>
          <button className="btn primary" disabled={disabled || !!err} onClick={() => onSave({ type, ref, label: null })}>Save key {glyph}</button>
        </div>
      </div>
    </div>
  );
}

// Compact fallback destination selector (type + value) for the fallback card.
function FallbackDest({ value, exts, queues, ringGroups, tenantDialContext, disabled, onChange }: {
  value: { type: DestinationType | ""; ref: string };
  exts: ExtensionSuggestion[]; queues: NumberSuggestion[]; ringGroups: NumberSuggestion[]; tenantDialContext: string | null; disabled?: boolean;
  onChange: (v: { type: DestinationType | ""; ref: string }) => void;
}) {
  const parsed = parseDestinationRef(value.type, value.ref);
  const emit = (type: DestinationType | "", selected: string, free: string) => {
    if (!type) { onChange({ type: "", ref: "" }); return; }
    if (type === "terminate") { onChange({ type, ref: buildDestinationRef("terminate", "", "", {}) }); return; }
    const extensionRow = type === "extension" ? exts.find((e) => e.extension === selected) : undefined;
    const usesSelect = ["extension", "queue", "ring_group", "voicemail"].includes(type);
    onChange({ type, ref: buildDestinationRef(type, usesSelect ? selected : "", usesSelect ? "" : free, { extensionRow, tenantDialContext }) });
  };
  const opts = value.type === "queue" ? queues : value.type === "ring_group" ? ringGroups
    : exts.map((e) => ({ number: e.extension, name: e.name }));
  return (
    <div className="rowmini">
      <select className="sel" disabled={disabled} value={value.type} onChange={(e) => emit(e.target.value as DestinationType | "", "", "")}>
        <option value="">Fall through (default)</option>
        {(["extension", "queue", "ring_group", "voicemail", "terminate"] as DestinationType[]).map((t) => <option key={t} value={t}>{DESTINATION_TYPE_LABELS[t]}</option>)}
      </select>
      {value.type && value.type !== "terminate" && (
        <select className="sel" disabled={disabled} value={parsed.selected} onChange={(e) => emit(value.type, e.target.value, "")}>
          <option value="">Choose…</option>
          {opts.map((o) => <option key={o.number} value={o.number}>{o.name ?? o.number}</option>)}
        </select>
      )}
    </div>
  );
}

function FlowStep({ icon, node, term, t, d, chip, chipType, last }: { icon?: string; node?: string; term?: boolean; t: string; d: string; chip?: string; chipType?: DestinationType; last?: boolean }) {
  return (
    <div className="step">
      <div className="rail">
        <div className={"node" + (term ? " term" : "")}>{node ? node : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} dangerouslySetInnerHTML={{ __html: icon ?? "" }} />}</div>
        {!last && <div className="line" />}
      </div>
      <div className="step-b">
        <div className="t">{t}</div>
        <div className="d">{d}</div>
        {chip && <div className="chip"><svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M8 5v14l11-7z" /></svg>{chip}</div>}
        {chipType && <div className="chip"><span className="ic"><Svg type={chipType} /></span>{DESTINATION_TYPE_LABELS[chipType]}</div>}
      </div>
    </div>
  );
}

function StudioStyles() {
  return (
    <style jsx global>{`
      .ivrs{--accent:#22a8ff;--accent-soft:rgba(34,168,255,.14);--panel:#141f2b;--panel-2:#1a2635;
        --bg-soft:#101923;--text:#e1e9f1;--dim:#8ea0b2;--border:#26374a;--border-soft:rgba(136,159,190,.20);
        --success:#34c27b;--warning:#f0b655;--danger:#ea6068;--radius-lg:20px;
        --shadow:0 24px 64px -36px rgba(0,0,0,.7),0 8px 22px -18px rgba(0,0,0,.55);
        color:var(--text);max-width:1240px;margin:0 auto;padding:6px 2px 60px;}
      :root[data-theme="light"] .ivrs{--panel:#fff;--panel-2:#f6f9fc;--bg-soft:#e9edf3;--text:#15233b;--dim:#68758a;
        --accent:#2f6bff;--accent-soft:rgba(47,107,255,.10);--border:rgba(15,23,42,.12);--border-soft:rgba(15,23,42,.08);
        --shadow:0 24px 60px -40px rgba(40,56,87,.42),0 8px 22px -18px rgba(74,63,53,.14);}
      .ivrs *{box-sizing:border-box}
      .ivrs svg{display:block}
      .ivrs .bar{display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 18px;box-shadow:var(--shadow)}
      .ivrs .brand{display:flex;align-items:center;gap:11px;font-weight:650}
      .ivrs .logo{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(150deg,var(--accent),#0a6bd8);color:#fff;font-weight:800;font-size:15px}
      .ivrs .crumbs{color:var(--dim);font-size:13px;display:flex;gap:8px;align-items:center}.ivrs .crumbs b{color:var(--text)}
      .ivrs .spacer{flex:1}
      .ivrs .tenant{display:flex;align-items:center;gap:9px;background:var(--panel);border:1px solid var(--border);padding:7px 12px;border-radius:11px;font-size:13.5px}
      .ivrs .tenant .dot{width:8px;height:8px;border-radius:50%;background:var(--success);box-shadow:0 0 0 3px rgba(52,194,123,.18)}
      .ivrs .tenant .car{color:var(--dim);font-size:11px}
      .ivrs .btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:11px;padding:9px 15px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:.15s}
      .ivrs .btn:hover{border-color:var(--accent);color:var(--accent)}
      .ivrs .btn:disabled{opacity:.5;cursor:not-allowed}
      .ivrs .btn.primary{background:linear-gradient(150deg,var(--accent),#0f7ede);border-color:transparent;color:#fff;box-shadow:0 10px 24px -12px rgba(34,168,255,.7)}
      .ivrs .btn.primary:hover{filter:brightness(1.06);color:#fff}
      .ivrs .btn.ghost{background:transparent}.ivrs .iconbtn{width:34px;height:34px;padding:0;justify-content:center}
      .ivrs .titlerow{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:22px 2px 14px;flex-wrap:wrap}
      .ivrs .titlerow p{margin:8px 0 0;color:var(--dim);font-size:14px;max-width:56ch}
      .ivrs .eyebrow{font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--dim)}
      .ivrs .name-edit{display:inline-flex;align-items:center;gap:9px}
      .ivrs .name-select{background:var(--panel);border:1px dashed var(--border);border-radius:12px;padding:8px 13px;font-size:16px;font-weight:650;color:var(--text);font-family:inherit;cursor:pointer}
      .ivrs .status-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;padding:6px 11px;border-radius:999px;border:1px solid;color:var(--warning);border-color:rgba(240,182,85,.4);background:rgba(240,182,85,.10)}
      .ivrs .banner{margin:0 2px 14px;padding:11px 14px;border-radius:12px;background:var(--accent-soft);border:1px solid var(--border);color:var(--dim);font-size:13px;display:flex;align-items:center;gap:10px}
      .ivrs .banner.err{background:rgba(234,96,104,.10);border-color:rgba(234,96,104,.35);color:var(--danger)}
      .ivrs .banner button{margin-left:auto;background:none;border:none;color:inherit;font-size:18px;cursor:pointer}
      .ivrs .grid{display:grid;grid-template-columns:1.55fr .95fr;gap:18px;align-items:start}
      @media (max-width:940px){.ivrs .grid{grid-template-columns:1fr}}
      .ivrs .card{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow);overflow:hidden}
      .ivrs .card+.card{margin-top:18px}
      .ivrs .card-h{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border-soft)}
      .ivrs .card-h .ix{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
      .ivrs .card-h h2{font-size:15px;margin:0;font-weight:650}.ivrs .card-h .sub{color:var(--dim);font-size:12.5px;margin-top:1px}
      .ivrs .card-b{padding:18px}
      .ivrs .rec{display:flex;align-items:center;gap:14px;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:12px 14px}
      .ivrs .play{width:44px;height:44px;border-radius:12px;border:none;cursor:pointer;flex:none;display:grid;place-items:center;background:linear-gradient(150deg,var(--accent),#0f7ede);color:#fff}
      .ivrs .wave{flex:1;height:34px;display:flex;align-items:center;gap:3px;overflow:hidden}
      .ivrs .wave i{width:3px;border-radius:2px;background:var(--accent);opacity:.55}
      .ivrs .rec .meta{min-width:0}.ivrs .rec .meta b{font-weight:600;font-size:14px}.ivrs .rec .meta span{display:block;color:var(--dim);font-size:12px;margin-top:1px}
      .ivrs .rec .swap{margin-left:auto}
      .ivrs .pill-mini{font-size:11px;color:var(--dim);border:1px solid var(--border);border-radius:999px;padding:3px 9px}
      .ivrs .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:var(--dim)}
      .ivrs .legend i{width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:middle}
      .ivrs .kp-help{display:flex;align-items:center;gap:10px;color:var(--dim);font-size:13px;margin-bottom:14px}
      .ivrs .keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}
      .ivrs .key{position:relative;text-align:left;background:var(--panel);border:1px solid var(--border);border-radius:15px;padding:13px;cursor:pointer;transition:.16s;min-height:76px;display:flex;flex-direction:column;gap:7px;font:inherit;color:var(--text)}
      .ivrs .key:hover{border-color:var(--accent);transform:translateY(-2px)}
      .ivrs .key.sel{border-color:var(--accent);background:linear-gradient(180deg,var(--accent-soft),var(--panel));box-shadow:0 0 0 1px var(--accent) inset}
      .ivrs .key.empty{border-style:dashed;color:var(--dim)}
      .ivrs .key .num{font-size:19px;font-weight:750;display:flex;align-items:center;gap:8px}
      .ivrs .key .num .g{font-size:10px;color:var(--dim);font-weight:600}
      .ivrs .key .dest{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:550;min-width:0}
      .ivrs .key .dest .ic{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;flex:none;background:var(--accent-soft);color:var(--accent)}
      .ivrs .key .dest .ic svg{width:14px;height:14px}
      .ivrs .key .dest .tx{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ivrs .key.empty .dest{color:var(--dim);font-weight:500}
      .ivrs .key .tag{position:absolute;top:11px;right:12px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);font-weight:700}
      .ivrs .k-term .ic{background:rgba(234,96,104,.14)!important;color:var(--danger)!important}
      .ivrs .k-ext .ic{background:rgba(52,194,123,.16)!important;color:var(--success)!important}
      .ivrs .fb{display:grid;grid-template-columns:1fr 1fr;gap:14px}
      @media (max-width:560px){.ivrs .fb{grid-template-columns:1fr}}
      .ivrs .fbx{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:14px}
      .ivrs .fbx h3{margin:0 0 3px;font-size:13.5px;font-weight:650;display:flex;align-items:center;gap:8px}
      .ivrs .fbx p{margin:0 0 12px;color:var(--dim);font-size:12.5px}
      .ivrs .field{margin-top:10px}
      .ivrs .field label{display:block;font-size:11.5px;color:var(--dim);margin-bottom:5px;font-weight:600}
      .ivrs .sel,.ivrs .inp{width:100%;font:inherit;font-size:13px;color:var(--text);background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;padding:9px 11px}
      .ivrs .sel:focus,.ivrs .inp:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
      .ivrs .rowmini{display:flex;gap:10px}.ivrs .rowmini .field{flex:1;margin-top:0}
      .ivrs .sticky{position:sticky;top:18px}
      .ivrs .flow{display:flex;flex-direction:column}
      .ivrs .step{display:flex;gap:13px;align-items:flex-start}
      .ivrs .rail{display:flex;flex-direction:column;align-items:center;flex:none}
      .ivrs .node{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;font-size:13px;font-weight:700;background:var(--accent-soft);color:var(--accent);border:1px solid rgba(34,168,255,.35)}
      .ivrs .node.term{background:rgba(234,96,104,.14);color:var(--danger);border-color:rgba(234,96,104,.35)}
      .ivrs .line{width:2px;flex:1;min-height:20px;background:linear-gradient(var(--border),transparent)}
      .ivrs .step-b{padding-bottom:16px;min-width:0}.ivrs .step-b .t{font-size:13.5px;font-weight:600}.ivrs .step-b .d{color:var(--dim);font-size:12.5px;margin-top:2px}
      .ivrs .step-b .chip{display:inline-flex;align-items:center;gap:6px;margin-top:7px;font-size:12px;background:var(--panel);border:1px solid var(--border);border-radius:9px;padding:5px 9px}
      .ivrs .chip .ic{width:16px;height:16px;color:var(--accent);display:grid;place-items:center}.ivrs .chip .ic svg{width:14px;height:14px}
      .ivrs .reclist{display:flex;flex-direction:column;gap:9px;max-height:320px;overflow:auto}
      .ivrs .recrow{display:flex;align-items:center;gap:11px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:9px 11px;cursor:pointer;transition:.14s}
      .ivrs .recrow:hover{border-color:var(--accent)}
      .ivrs .recrow .p{width:32px;height:32px;border-radius:9px;flex:none;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);border:none;cursor:pointer}
      .ivrs .recrow .nm{min-width:0}.ivrs .recrow .nm b{font-size:13px;font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ivrs .recrow .nm span{font-size:11px;color:var(--dim)}
      .ivrs .recrow .len{margin-left:auto;font-size:11.5px;color:var(--dim)}
      .ivrs .emptxt{color:var(--dim);font-size:12.5px;padding:8px 2px}
      .ivrs .sync{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dim);margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)}
      .ivrs .sync .d{width:7px;height:7px;border-radius:50%;background:var(--success)}
      .ivrs .editor{margin-top:15px;background:var(--panel);border:1px solid var(--accent);border-radius:15px;box-shadow:0 18px 40px -22px rgba(34,168,255,.5);overflow:hidden}
      .ivrs .editor-h{display:flex;align-items:center;gap:11px;padding:13px 15px;background:var(--accent-soft);border-bottom:1px solid var(--border-soft)}
      .ivrs .editor-h .kb{width:30px;height:30px;border-radius:9px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:750}
      .ivrs .editor-h b{font-size:14px}.ivrs .editor-h span{color:var(--dim);font-size:12px}
      .ivrs .editor-b{padding:15px}
      .ivrs .types{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:6px}
      .ivrs .type{display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 6px;border-radius:11px;border:1px solid var(--border);background:var(--bg-soft);cursor:pointer;font-size:11.5px;color:var(--dim);transition:.14s;font-family:inherit}
      .ivrs .type:hover{border-color:var(--accent);color:var(--text)}
      .ivrs .type.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);font-weight:600}
      .ivrs .type svg{width:18px;height:18px}
      .ivrs .foot{display:flex;gap:10px;justify-content:flex-end;margin-top:15px}
      .ivrs .hint{font-size:12px;margin-top:8px}.ivrs .hint.err{color:var(--danger)}
      .ivrs .days{display:flex;flex-direction:column;gap:7px}
      .ivrs .dayrow{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);border-radius:11px;padding:8px 12px}
      .ivrs .dayrow.closed{border-style:dashed}
      .ivrs .daytoggle{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600;min-width:118px;cursor:pointer}
      .ivrs .daytoggle input{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
      .ivrs .dayrow.closed .daytoggle{color:var(--dim);font-weight:500}
      .ivrs .daytimes{display:flex;align-items:center;gap:9px;font-size:13px}
      .ivrs .daytimes .to{color:var(--dim);font-size:12px}
      .ivrs .daytimes.closedtxt{color:var(--dim);font-size:12.5px}
      .ivrs .inp.time{width:auto;padding:6px 9px}
      .ivrs .holidays{display:flex;flex-wrap:wrap;gap:7px;align-items:center;min-height:24px}
      .ivrs .hchip{display:inline-flex;align-items:center;gap:7px;font-size:12px;background:var(--bg-soft);border:1px solid var(--border);border-radius:999px;padding:4px 6px 4px 11px}
      .ivrs .hchip button{background:none;border:none;color:var(--dim);cursor:pointer;font-size:15px;line-height:1;padding:0 4px}
      .ivrs .hchip button:hover{color:var(--danger)}
      .ivrs .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent);color:var(--text);padding:11px 18px;border-radius:12px;box-shadow:var(--shadow);font-size:13.5px;font-weight:600;z-index:60}
    `}</style>
  );
}
