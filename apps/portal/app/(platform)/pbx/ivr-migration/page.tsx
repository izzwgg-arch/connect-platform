"use client";

// ── IVR Migration ────────────────────────────────────────────────────────────
// Every phone menu on the PBX, tenant by tenant, and how far each one has got
// on its way into Connect. Two buttons per menu, deliberately separate:
//
//   Copy into Connect  rebuilds the menu, its after-hours partner and its
//                      opening hours inside Connect. Callers are untouched.
//   Go live            flips the phone numbers over to Connect. Reversible
//                      from the DID Routing page in one click.
//
// Nothing is copied without showing exactly what will be created first,
// including anything that can't be reproduced.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPost } from "../../../../services/apiClient";

type MenuStatus = "not_started" | "copied" | "live";

interface MappedDid {
  did: string;
  description: string;
  /** Connect's DID mapping id — null until the menu has been copied. */
  mappingId: string | null;
  routingMode: "pbx" | "connect";
  readyToGoLive: boolean;
}

interface MappedIvr {
  id: number;
  description: string;
  options: Array<{ digit: string; enabled: boolean; target: { type: string; label: string | null } | null }>;
  welcome: { id: number; name: string | null } | null;
  connectProfileId: string | null;
  connectProfileName: string | null;
  copiedAt: string | null;
  dids: MappedDid[];
  status: MenuStatus;
}

interface MappedTenant {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  ivrs: MappedIvr[];
  routes: Array<{ did: string; description: string; target: { type: string; targetId: string | null } | null }>;
  timeConditions: Array<{ id: number; description: string; timeGroup: { schedules: string[] } | null }>;
}

interface PlanProfile { pbxIvrId: number; name: string; type: string; options: Array<{ optionDigit: string; label: string; handsBackToPbx: boolean }> }
interface PlanProblem { where: string; reason: string }
interface Plan {
  profiles: PlanProfile[];
  schedule: { timezone: string; rules: Array<{ day: number; open: string; close: string }>; pbxTimeConditionName: string } | null;
  dids: Array<{ did: string; description: string; viaTimeCondition: boolean }>;
  requiredRecordings: Array<{ recordingId: number; name: string; promptRef: string; inConnectCatalog?: boolean }>;
  keptByDirectDial: string[];
  problems: PlanProblem[];
  warnings: string[];
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const STATUS_LABEL: Record<MenuStatus, string> = {
  not_started: "On the PBX",
  copied: "Copied — not live",
  live: "Live on Connect",
};

export default function IvrMigrationPage() {
  const { tenantId } = useAppContext();
  const [tenants, setTenants] = useState<MappedTenant[]>([]);
  const [capturedAt, setCapturedAt] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openTenant, setOpenTenant] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ pbxTenantId: number; pbxIvrId: number; plan: Plan } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3200); };

  const load = useCallback(async () => {
    setLoading(true); setError(null); setErrorDetail(null);
    try {
      const r = await apiGet<{ capturedAt: string; tenants: MappedTenant[] }>("/voice/ivr/migration/map");
      setTenants(r.tenants || []);
      setCapturedAt(r.capturedAt || "");
    } catch (e: any) {
      // The two failures worth telling apart: the reader isn't installed on
      // the PBX yet, versus the PBX can't be reached at all.
      const payload = e?.payload ?? {};
      setError(
        payload.error === "pbx_helper_too_old" ? "The PBX doesn't have the call-flow reader installed yet."
          : payload.error === "pbx_helper_not_configured" ? "Connect isn't set up to talk to the PBX helper."
          : "Couldn't read the PBX.",
      );
      setErrorDetail(payload.detail ?? e?.message ?? null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    const all = tenants.flatMap((t) => t.ivrs);
    return {
      menus: all.length,
      live: all.filter((i) => i.status === "live").length,
      copied: all.filter((i) => i.status === "copied").length,
    };
  }, [tenants]);

  async function preview(t: MappedTenant, ivr: MappedIvr) {
    if (!tenantId) { setError("Pick a tenant in the switcher first — that's the Connect account the menu gets copied into."); return; }
    setBusy(`plan:${ivr.id}`); setError(null);
    try {
      const r = await apiPost<{ plan: Plan }>("/voice/ivr/migration/plan", { tenantId, pbxTenantId: t.tenantId, pbxIvrId: ivr.id });
      setPlan({ pbxTenantId: t.tenantId, pbxIvrId: ivr.id, plan: r.plan });
    } catch (e: any) {
      setError(e?.payload?.detail || e?.message || "Couldn't work out what copying this menu would do");
    } finally { setBusy(null); }
  }

  // Go live / roll back. Both go through the existing, already-audited DID
  // switch endpoints — the ones that snapshot the PBX destination before
  // touching it and can PATCH it back verbatim. Nothing bespoke here.
  async function flipDids(ivr: MappedIvr, direction: "connect" | "pbx") {
    const targets = ivr.dids.filter((d) => d.mappingId && d.routingMode !== direction);
    if (targets.length === 0) { flash("Nothing to change — those numbers are already where you want them."); return; }
    const goingLive = direction === "connect";
    const ok = window.confirm(
      (goingLive
        ? `Send live callers to Connect's copy of "${ivr.description}"?\n\n`
        : `Hand "${ivr.description}" back to the PBX?\n\n`)
      + targets.map((d) => `  ${d.did}${d.description ? ` · ${d.description}` : ""}`).join("\n")
      + (goingLive
        ? "\n\nThe current PBX setting is saved first, so this can be undone from here or from DID Routing."
        : "\n\nEach number goes back to exactly the setting saved when it was taken over."),
    );
    if (!ok) return;

    setBusy(`flip:${ivr.id}`); setError(null);
    const failures: string[] = [];
    for (const d of targets) {
      try {
        await apiPost(`/voice/did/${encodeURIComponent(d.mappingId!)}/switch-to-${direction}`, {});
      } catch (e: any) {
        failures.push(`${d.did}: ${e?.payload?.detail || e?.message || "failed"}`);
      }
    }
    setBusy(null);
    // Report per-number. A partial flip is the dangerous case — one number on
    // Connect and another still on the PBX — so it must never look like a
    // clean success.
    if (failures.length === 0) {
      flash(goingLive ? `Live on Connect: ${targets.map((d) => d.did).join(", ")}` : `Back on the PBX: ${targets.map((d) => d.did).join(", ")}`);
    } else {
      setError(`${targets.length - failures.length} of ${targets.length} numbers changed. Still to fix — ${failures.join("; ")}`);
    }
    await load();
  }

  async function copyIn(allowPartial: boolean) {
    if (!plan || !tenantId) return;
    setBusy("import"); setError(null);
    try {
      const r = await apiPost<{ profiles: Array<{ name: string }> }>("/voice/ivr/migration/import", {
        tenantId, pbxTenantId: plan.pbxTenantId, pbxIvrId: plan.pbxIvrId, allowPartial,
      });
      flash(`Copied ${r.profiles.length} menu${r.profiles.length === 1 ? "" : "s"} into Connect. Callers still hear the PBX until you go live.`);
      setPlan(null);
      await load();
    } catch (e: any) {
      setError(e?.payload?.detail || e?.message || "Couldn't copy that menu");
    } finally { setBusy(null); }
  }

  return (
    <div className="ivrm">
      <MigrationStyles />

      <div className="head">
        <div>
          <div className="eyebrow">PBX · IVR Migration</div>
          <h1>Take phone menus over from the PBX</h1>
          <p>
            Every menu on the PBX, and how far each one has got. Copying a menu rebuilds it inside Connect
            without changing anything for callers — going live is a separate button, and it can be undone.
          </p>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" /></svg>
          {loading ? "Reading the PBX…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="banner err">
          <div><b>{error}</b>{errorDetail && <div className="detail">{errorDetail}</div>}</div>
          <button onClick={() => { setError(null); setErrorDetail(null); }}>×</button>
        </div>
      )}

      {!error && !loading && (
        <div className="tally">
          <span><b>{totals.menus}</b> menus on the PBX</span>
          <span><b>{totals.copied}</b> copied, waiting to go live</span>
          <span><b>{totals.live}</b> live on Connect</span>
          {capturedAt && <span className="dim">read {new Date(capturedAt).toLocaleString()}</span>}
        </div>
      )}

      {loading && <div className="banner">Reading every tenant on the PBX — this takes a moment.</div>}
      {!loading && !error && tenants.length === 0 && <div className="banner">No tenants came back from the PBX.</div>}

      {tenants.filter((t) => t.ivrs.length > 0).map((t) => {
        const open = openTenant === t.tenantId;
        const live = t.ivrs.filter((i) => i.status === "live").length;
        return (
          <div key={t.tenantId} className="tcard">
            <button className="thead" onClick={() => setOpenTenant(open ? null : t.tenantId)}>
              <svg className={"chev" + (open ? " open" : "")} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="m9 18 6-6-6-6" /></svg>
              <div className="tname">{t.tenantName}<span className="tslug">tenant {t.tenantId}</span></div>
              <div className="tmeta">
                {t.ivrs.length} menu{t.ivrs.length === 1 ? "" : "s"}
                {live > 0 && <span className="chip live">{live} live</span>}
              </div>
            </button>

            {open && (
              <div className="tbody">
                {t.ivrs.map((ivr) => (
                  <div key={ivr.id} className="menurow">
                    <div className="mname">
                      <b>{ivr.description || `Menu ${ivr.id}`}</b>
                      <span>
                        {ivr.options.filter((o) => o.enabled).length} key{ivr.options.filter((o) => o.enabled).length === 1 ? "" : "s"}
                        {ivr.welcome?.name ? ` · plays "${ivr.welcome.name}"` : ""}
                      </span>
                    </div>
                    <span className={`chip ${ivr.status}`}>{STATUS_LABEL[ivr.status]}</span>
                    <div className="macts">
                      <button className="btn ghost" disabled={busy === `plan:${ivr.id}`} onClick={() => preview(t, ivr)}>
                        {busy === `plan:${ivr.id}` ? "…" : ivr.status === "not_started" ? "See what copying does" : "Re-copy"}
                      </button>
                      {ivr.status === "copied" && ivr.dids.some((d) => d.readyToGoLive) && (
                        <button className="btn primary" disabled={busy === `flip:${ivr.id}`} onClick={() => flipDids(ivr, "connect")}>
                          {busy === `flip:${ivr.id}` ? "…" : "Go live"}
                        </button>
                      )}
                      {ivr.status === "live" && (
                        <button className="btn ghost danger" disabled={busy === `flip:${ivr.id}`} onClick={() => flipDids(ivr, "pbx")}>
                          {busy === `flip:${ivr.id}` ? "…" : "Back to PBX"}
                        </button>
                      )}
                    </div>
                    {ivr.dids.length > 0 && (
                      <div className="mdids">
                        {ivr.dids.map((d) => (
                          <span key={d.did} className={"did" + (d.routingMode === "connect" ? " on" : "")}>{d.did}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                <div className="tfoot">
                  Numbers on this tenant:{" "}
                  {t.routes.length === 0 ? "none" : t.routes.map((r) => r.did).join(", ")}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {plan && (
        <PlanModal
          plan={plan.plan}
          busy={busy === "import"}
          onClose={() => setPlan(null)}
          onCopy={copyIn}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ── "here's exactly what will happen" ────────────────────────────────────────
function PlanModal({ plan, busy, onClose, onCopy }: {
  plan: Plan; busy: boolean; onClose: () => void; onCopy: (allowPartial: boolean) => void;
}) {
  const [confirmPartial, setConfirmPartial] = useState(false);
  const blocked = plan.problems.length > 0 && !confirmPartial;
  const missingAudio = plan.requiredRecordings.filter((r) => r.inConnectCatalog === false);

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <div><b>What copying this menu will do</b><span>Nothing changes for callers yet.</span></div>
          <button className="btn ghost iconbtn" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="mbody">
          <section>
            <h3>Menus Connect will build</h3>
            {plan.profiles.map((p) => (
              <div key={p.pbxIvrId} className="pbox">
                <b>{p.name}</b>{p.type === "after_hours" && <span className="tag">plays when closed</span>}
                <ul>
                  {p.options.length === 0 && <li className="dim">No keys</li>}
                  {p.options.map((o) => (
                    <li key={o.optionDigit}>
                      <span className="kb">{o.optionDigit === "star" ? "*" : o.optionDigit === "hash" ? "#" : o.optionDigit}</span>
                      {o.label}
                      {o.handsBackToPbx && <span className="tag soft">stays on the PBX</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          {plan.schedule && (
            <section>
              <h3>Opening hours it will copy</h3>
              <div className="pbox">
                <b>From the PBX rule &ldquo;{plan.schedule.pbxTimeConditionName}&rdquo;</b>
                <span className="dim"> ({plan.schedule.timezone})</span>
                <ul className="hours">
                  {DAY_SHORT.map((d, i) => {
                    const r = plan.schedule!.rules.find((x) => x.day === i);
                    return <li key={d}><span className="dow">{d}</span>{r ? `${r.open} – ${r.close}` : <span className="dim">closed</span>}</li>;
                  })}
                </ul>
              </div>
            </section>
          )}

          <section>
            <h3>Numbers this menu answers</h3>
            {plan.dids.length === 0
              ? <p className="dim">None — copying it won&apos;t change any caller&apos;s experience until you point a number at it.</p>
              : <ul className="plain">{plan.dids.map((d) => <li key={d.did}>{d.did}{d.description ? ` · ${d.description}` : ""}{d.viaTimeCondition && <span className="tag soft">via the hours rule</span>}</li>)}</ul>}
          </section>

          {missingAudio.length > 0 && (
            <section>
              <h3>Recordings not in Connect yet</h3>
              <p className="dim">
                The copy still works, but Connect won&apos;t let you publish until these are uploaded —
                that guard is there so a menu can&apos;t answer with silence.
              </p>
              <ul className="plain">{missingAudio.map((r) => <li key={r.recordingId}>{r.name}</li>)}</ul>
            </section>
          )}

          {plan.keptByDirectDial.length > 0 && (
            <section>
              <h3>Extension shortcuts — kept</h3>
              <p className="dim">
                The PBX lists these extensions on the menu one by one. Connect keeps them working through
                dial-by-extension, so callers can still dial them: {plan.keptByDirectDial.join(", ")}.
              </p>
            </section>
          )}

          {plan.warnings.length > 0 && (
            <section>
              <h3>Worth knowing</h3>
              <ul className="plain warn">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </section>
          )}

          {plan.problems.length > 0 && (
            <section>
              <h3 className="bad">Connect can&apos;t reproduce these</h3>
              <ul className="plain bad">{plan.problems.map((p, i) => <li key={i}><b>{p.where}</b> — {p.reason}</li>)}</ul>
              <label className="confirm">
                <input type="checkbox" checked={confirmPartial} onChange={(e) => setConfirmPartial(e.target.checked)} />
                Copy the rest anyway — I&apos;ll set these by hand in the Studio
              </label>
            </section>
          )}
        </div>

        <div className="mfoot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || blocked} onClick={() => onCopy(confirmPartial)}>
            {busy ? "Copying…" : "Copy into Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MigrationStyles() {
  return (
    <style jsx global>{`
      .ivrm{--accent:#22a8ff;--accent-soft:rgba(34,168,255,.14);--panel:#141f2b;--panel-2:#1a2635;
        --bg-soft:#101923;--text:#e1e9f1;--dim:#8ea0b2;--border:#26374a;--border-soft:rgba(136,159,190,.20);
        --success:#34c27b;--warning:#f0b655;--danger:#ea6068;--radius-lg:20px;
        --shadow:0 24px 64px -36px rgba(0,0,0,.7),0 8px 22px -18px rgba(0,0,0,.55);
        color:var(--text);max-width:1080px;margin:0 auto;padding:6px 2px 60px;}
      :root[data-theme="light"] .ivrm{--panel:#fff;--panel-2:#f6f9fc;--bg-soft:#e9edf3;--text:#15233b;--dim:#68758a;
        --accent:#2f6bff;--accent-soft:rgba(47,107,255,.10);--border:rgba(15,23,42,.12);--border-soft:rgba(15,23,42,.08);
        --shadow:0 24px 60px -40px rgba(40,56,87,.42),0 8px 22px -18px rgba(74,63,53,.14);}
      .ivrm *{box-sizing:border-box}
      .ivrm svg{display:block}
      .ivrm .head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin:6px 2px 18px;flex-wrap:wrap}
      .ivrm .head h1{font-size:23px;margin:7px 0 0;font-weight:680}
      .ivrm .head p{margin:9px 0 0;color:var(--dim);font-size:14px;max-width:62ch}
      .ivrm .eyebrow{font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--dim)}
      .ivrm .btn{font:inherit;font-size:13.5px;font-weight:600;border-radius:11px;padding:9px 15px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:.15s}
      .ivrm .btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
      .ivrm .btn:disabled{opacity:.5;cursor:not-allowed}
      .ivrm .btn.primary{background:linear-gradient(150deg,var(--accent),#0f7ede);border-color:transparent;color:#fff}
      .ivrm .btn.primary:hover:not(:disabled){filter:brightness(1.06);color:#fff}
      .ivrm .btn.ghost{background:transparent}
      .ivrm .iconbtn{width:34px;height:34px;padding:0;justify-content:center}
      .ivrm .banner{margin:0 2px 14px;padding:12px 15px;border-radius:12px;background:var(--accent-soft);border:1px solid var(--border);color:var(--dim);font-size:13px;display:flex;align-items:flex-start;gap:10px}
      .ivrm .banner.err{background:rgba(234,96,104,.10);border-color:rgba(234,96,104,.35);color:var(--danger)}
      .ivrm .banner .detail{color:var(--dim);font-size:12.5px;margin-top:4px;font-weight:400}
      .ivrm .banner button{margin-left:auto;background:none;border:none;color:inherit;font-size:18px;cursor:pointer;line-height:1}
      .ivrm .tally{display:flex;gap:20px;flex-wrap:wrap;font-size:13px;color:var(--dim);margin:0 2px 16px}
      .ivrm .tally b{color:var(--text);font-size:15px;margin-right:5px}
      .ivrm .tally .dim{margin-left:auto;font-size:12px}
      .ivrm .tcard{background:linear-gradient(180deg,var(--panel-2),var(--panel));border:1px solid var(--border);border-radius:15px;box-shadow:var(--shadow);overflow:hidden;margin-bottom:11px}
      .ivrm .thead{width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;background:none;border:none;color:var(--text);font:inherit;cursor:pointer;text-align:left}
      .ivrm .thead:hover{background:var(--accent-soft)}
      .ivrm .chev{color:var(--dim);transition:transform .16s;flex:none}
      .ivrm .chev.open{transform:rotate(90deg)}
      .ivrm .tname{font-weight:650;font-size:14.5px;display:flex;flex-direction:column;gap:2px}
      .ivrm .tslug{font-size:11.5px;color:var(--dim);font-weight:500}
      .ivrm .tmeta{margin-left:auto;font-size:12.5px;color:var(--dim);display:flex;align-items:center;gap:9px}
      .ivrm .tbody{border-top:1px solid var(--border-soft);padding:12px 16px 14px}
      .ivrm .menurow{display:flex;align-items:center;gap:13px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--panel);margin-bottom:8px;flex-wrap:wrap}
      .ivrm .mname{min-width:190px;flex:1}
      .ivrm .mname b{font-size:13.5px;font-weight:620;display:block}
      .ivrm .mname span{font-size:11.5px;color:var(--dim)}
      .ivrm .macts{margin-left:auto;display:flex;gap:8px}
      .ivrm .chip{font-size:11px;font-weight:650;padding:4px 10px;border-radius:999px;border:1px solid var(--border);color:var(--dim);white-space:nowrap}
      .ivrm .chip.live{color:var(--success);border-color:rgba(52,194,123,.4);background:rgba(52,194,123,.10)}
      .ivrm .chip.copied{color:var(--warning);border-color:rgba(240,182,85,.4);background:rgba(240,182,85,.10)}
      .ivrm .btn.danger:hover:not(:disabled){border-color:var(--danger);color:var(--danger)}
      .ivrm .mdids{flex-basis:100%;display:flex;gap:6px;flex-wrap:wrap;padding-top:2px}
      .ivrm .did{font-size:11px;color:var(--dim);border:1px solid var(--border);border-radius:6px;padding:2px 7px;font-variant-numeric:tabular-nums}
      .ivrm .did.on{color:var(--success);border-color:rgba(52,194,123,.4);background:rgba(52,194,123,.10)}
      .ivrm .tfoot{font-size:11.5px;color:var(--dim);padding-top:6px}
      .ivrm .backdrop{position:fixed;inset:0;background:rgba(4,10,17,.62);display:grid;place-items:center;padding:22px;z-index:70}
      .ivrm .modal{background:var(--panel);border:1px solid var(--border);border-radius:17px;box-shadow:var(--shadow);width:min(660px,100%);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
      .ivrm .mhead{display:flex;align-items:center;gap:12px;padding:15px 17px;border-bottom:1px solid var(--border-soft);background:var(--accent-soft)}
      .ivrm .mhead b{font-size:14.5px;display:block}
      .ivrm .mhead span{font-size:12px;color:var(--dim)}
      .ivrm .mhead .iconbtn{margin-left:auto}
      .ivrm .mbody{padding:17px;overflow:auto}
      .ivrm .mbody section{margin-bottom:19px}
      .ivrm .mbody h3{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin:0 0 9px;font-weight:700}
      .ivrm .mbody h3.bad{color:var(--danger)}
      .ivrm .pbox{background:var(--bg-soft);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:9px;font-size:13px}
      .ivrm .pbox ul{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
      .ivrm .pbox li{display:flex;align-items:center;gap:9px;font-size:12.5px}
      .ivrm .kb{width:22px;height:22px;border-radius:7px;background:var(--accent);color:#fff;display:grid;place-items:center;font-size:11.5px;font-weight:750;flex:none}
      .ivrm .hours{display:grid;grid-template-columns:repeat(2,1fr);gap:5px 16px}
      .ivrm .hours .dow{display:inline-block;width:38px;color:var(--dim);font-weight:600}
      .ivrm .tag{font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;color:var(--accent);background:var(--accent-soft);border-radius:6px;padding:2px 7px;margin-left:8px}
      .ivrm .tag.soft{color:var(--dim);background:var(--border-soft)}
      .ivrm ul.plain{margin:0;padding:0 0 0 2px;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
      .ivrm ul.plain.warn li{color:var(--warning)}
      .ivrm ul.plain.bad li{color:var(--danger)}
      .ivrm .dim{color:var(--dim)}
      .ivrm .mbody p{margin:0 0 8px;font-size:12.5px}
      .ivrm .confirm{display:flex;align-items:center;gap:9px;margin-top:12px;font-size:12.5px;cursor:pointer}
      .ivrm .confirm input{width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
      .ivrm .mfoot{display:flex;gap:10px;justify-content:flex-end;padding:14px 17px;border-top:1px solid var(--border-soft)}
      .ivrm .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent);color:var(--text);padding:12px 19px;border-radius:12px;box-shadow:var(--shadow);font-size:13.5px;font-weight:600;z-index:80;max-width:min(560px,92vw);text-align:center}
    `}</style>
  );
}
