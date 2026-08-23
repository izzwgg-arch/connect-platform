"use client";

/**
 * Set Up My Phones.
 *
 * ⛔⛔ THE SCREENS ARE THE APPROVED MOCKUP, PORTED. Same steps, same order, same
 * words, same classes. Izzy, 2026-08-21: "make everything exactly 100% on the dot
 * like the mock-ups." This repo has shipped a screen built from a mockup's
 * structure with its own styling before, and the report claiming it matched had
 * never put the two side by side.
 *
 * ⛔ The customer never sees a hardware address, an IP, a provisioning URL or a
 * status code. Everything on this screen comes from the API's customer view, which
 * strips all of that at the source rather than here.
 *
 * ⛔ Discovery needs the desktop app, because a web page cannot see an office
 * network. When it is missing the wizard says so in plain words instead of failing
 * with a blank list, which would read as "you have no phones".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyDiscoveredHosts, shouldFingerprint, deviceKindFor, describeKind } from "@connect/shared";
import { apiGet, apiPost } from "../../services/apiClient";
import { createSetupDriver, type NeedsPerson } from "./setupDriver";
import "./deskPhones.css";

type CustomerPhone = {
  id: string;
  model: string | null;
  vendor: string | null;
  displayName: string | null;
  extNumber: string | null;
  status: "Finding" | "Preparing" | "Restarting" | "Connecting" | "Ready" | "Needs attention";
  note: string | null;
  needsAttention: boolean;
};

type RunSummary = {
  total: number; ready: number; working: number; needsAttention: number;
  finished: boolean; headline: string;
};

type Step =
  | "welcome" | "knowPhone" | "connection" | "network"
  | "searching" | "found" | "match" | "resetAuth" | "ready" | "live" | "done";

const STEP_ORDER: Step[] = ["welcome", "knowPhone", "connection", "network", "found", "match", "ready", "live"];

function desktop(): any | null {
  if (typeof window === "undefined") return null;
  return (window as any).connectDesktop ?? null;
}

/** ⛔ The photo comes from the PBX's own product images, filed under the model name. */
function photoFor(model: string | null): string | null {
  const m = String(model ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!m) return null;
  return `/api/desk-phones/photo/${encodeURIComponent(m)}`;
}

/**
 * A sentence a person can match to the thing on the desk, the wall or the ceiling.
 * ⛔ Not just desk phones any more (Izzy, 2026-08-22): an HT box, a cordless base,
 * a ceiling speaker and a door intercom each get words for what they LOOK like,
 * never a category name.
 */
function describe(model: string | null): string {
  const m = String(model ?? "").toUpperCase();
  const kind = deviceKindFor(m);
  if (kind !== "desk_phone" && kind !== "unknown") return describeKind(kind);
  if (/T5[4-8]/.test(m)) return "Big colour screen, buttons down the side";
  if (/T4[6-8]/.test(m)) return "Colour screen, several buttons";
  if (/T4[0-4]/.test(m)) return "Small screen, plain black handset";
  if (/T29|T27/.test(m)) return "Large phone, lots of buttons";
  if (/T3[0-4]/.test(m)) return "Small desk phone";
  if (/CP/.test(m)) return "Conference room speakerphone";
  if (/GXP|GRP|^X\d/.test(m)) return "Desk phone";
  return describeKind(kind);
}

export function DeskPhoneWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [runId, setRunId] = useState<string | null>(null);
  const [phones, setPhones] = useState<CustomerPhone[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [subnet, setSubnet] = useState<string | null>(null);
  const [extensions, setExtensions] = useState<Array<{ id: string; extNumber: string; displayName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [knowsPhone, setKnowsPhone] = useState<"yes" | "no" | null>(null);
  const [phoneNameHint, setPhoneNameHint] = useState("");
  const [connection, setConnection] = useState<"cable" | "wifi" | "unsure" | null>(null);
  const [othersCount, setOthersCount] = useState(0);
  const [needs, setNeeds] = useState<NeedsPerson[]>([]);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  /** Which devices are ticked on the clearing screen. ⛔ The person picks; default all. */
  const [clearTicks, setClearTicks] = useState<Record<string, boolean>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const driverRef = useRef<ReturnType<typeof createSetupDriver> | null>(null);
  const tickingRef = useRef(false);

  const hasDesktop = Boolean(desktop()?.phoneSetup);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const loadRun = useCallback(async (id: string) => {
    const out = await apiGet<{ phones: CustomerPhone[]; summary: RunSummary; run: { subnet: string | null } }>(
      `/desk-phones/runs/${id}`,
    );
    setPhones(out.phones);
    setSummary(out.summary);
    setSubnet(out.run.subnet);
    return out;
  }, []);

  const start = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const out = await apiPost<{ run: { id: string } }>("/desk-phones/runs", {
        deviceLabel: typeof navigator !== "undefined" ? navigator.platform : undefined,
      });
      setRunId(out.run.id);
      const ext = await apiGet<{ extensions: Array<{ id: string; extNumber: string; displayName: string }> }>(
        "/desk-phones/extensions",
      ).catch(() => ({ extensions: [] }));
      setExtensions(ext.extensions ?? []);
      setStep("knowPhone");
    } catch {
      setError("We could not start setup just now. Try again in a moment.");
    } finally { setBusy(false); }
  }, []);

  const search = useCallback(async () => {
    if (!runId) return;
    setStep("searching"); setError(null);
    const bridge = desktop()?.phoneSetup;
    if (!bridge) {
      // ⛔ Said plainly. An empty list here would read as "this office has no phones".
      setError("Phone setup needs the Loopcom app on a computer in the same office as your phones.");
      setStep("welcome");
      return;
    }
    try {
      const scan = await bridge.run({ op: "discover" });
      if (!scan?.ok) {
        setError("We could not search this network. Make sure this computer is on your office Wi-Fi or network cable.");
        setStep("welcome");
        return;
      }
      const hosts: Array<{ ip: string; mac: string; respondedOnHttp?: boolean }> = scan.scan?.hosts ?? [];
      // ⛔ Fingerprint only plausible candidates. A silent host on an unknown
      // hardware block is a laptop or a printer; spending four seconds and a rate
      // slot on each of them stalls the search for nothing.
      const enriched: any[] = [];
      for (const h of hosts) {
        if (!shouldFingerprint(h)) { enriched.push({ ...h, fingerprint: null }); continue; }
        const fp = await bridge.run({ op: "fingerprint", ip: h.ip }).catch(() => null);
        enriched.push({ ...h, fingerprint: fp?.ok ? fp.fingerprint : null });
      }
      // ⛔⛔ ONLY DEVICES WITH EVIDENCE OF BEING A PHONE ARE SUBMITTED. Before this
      // filter, every ARP entry went to the server — an office with four phones and
      // nineteen other devices opened on "We found 23 desk phones", with the
      // printer fleet dressed up as broken phones.
      const verdict = classifyDiscoveredHosts(enriched);
      setOthersCount(verdict.othersCount);
      const found = verdict.phones.map((h: any) => ({
        mac: h.mac, ip: h.ip,
        vendor: h.fingerprint?.vendor ?? undefined,
        model: h.fingerprint?.model ?? undefined,
        firmware: h.fingerprint?.firmware ?? undefined,
      }));
      const out = await apiPost<{ phones: CustomerPhone[]; subnet: string | null }>(
        `/desk-phones/runs/${runId}/discovered`,
        { subnet: scan.scan?.subnet ?? undefined, phones: found },
      );
      setPhones(out.phones);
      setSubnet(out.subnet);
      setStep("found");
    } catch {
      setError("Something went wrong while searching. Try again.");
      setStep("welcome");
    }
  }, [runId]);

  const assign = useCallback(async (phoneId: string, extensionId: string | null) => {
    if (!runId) return;
    try {
      await apiPost(`/desk-phones/runs/${runId}/phones/${phoneId}/assign`, { extensionId });
      await loadRun(runId);
    } catch { setError("That could not be saved. Try again."); }
  }, [runId, loadRun]);

  /**
   * ⛔⛔ THE LIVE STEP DRIVES, IT DOES NOT MERELY WATCH. Each tick asks the server
   * what each phone needs, performs the instructions this machine can perform
   * (default-credential check, fetch-your-settings, re-find after a restart),
   * reports what it observed, and surfaces the two things only a person may do —
   * approving a wipe, and typing a password. Found on the 2026-08-22 review pass:
   * before this, nothing called advance and setup could never finish.
   */
  const beginSetup = useCallback(async () => {
    if (!runId) return;
    setStep("live");
    const bridge = desktop()?.phoneSetup ?? null;
    driverRef.current = createSetupDriver(runId, { get: apiGet, post: apiPost }, bridge);
    const tickNow = async () => {
      // ⛔ Re-entry guard: a slow tick (each phone can cost a 4-second probe) must
      // not overlap the next interval firing, or two ticks advance the same phone.
      if (tickingRef.current || !driverRef.current) return;
      tickingRef.current = true;
      try {
        const out = await driverRef.current.tick();
        setPhones(out.phones);
        setSummary(out.summary);
        setNeeds(out.needs);
        if (out.finished) {
          if (pollRef.current) clearInterval(pollRef.current);
          setStep("done");
        }
      } catch { /* the next tick looks again */ }
      finally { tickingRef.current = false; }
    };
    void tickNow();
    pollRef.current = setInterval(tickNow, 4000);
  }, [runId]);

  /**
   * The person pressed the big button on the clearing screen. ⛔ Only the TICKED
   * devices are approved; the unticked ones are recorded as a deliberate no, which
   * ends their setup kindly rather than re-asking forever.
   */
  const approveReset = useCallback(async (allIds: string[]) => {
    if (!runId) return;
    const ticked = allIds.filter((id) => clearTicks[id] !== false);
    const declined = allIds.filter((id) => clearTicks[id] === false);
    if (declined.length) driverRef.current?.declineReset(declined);
    if (!ticked.length) {
      setNeeds((n) => n.filter((x) => x.kind !== "reset_authorization"));
      return;
    }
    try {
      await apiPost(`/desk-phones/runs/${runId}/authorize-reset`, { phoneIds: ticked });
      setNeeds((n) => n.filter((x) => x.kind !== "reset_authorization"));
    } catch (e: any) {
      // The api's own refusal is already plain English ("You are not allowed to
      // clear a phone. Ask somebody who is.").
      setError(e?.body?.message || "That could not be approved from this account.");
    }
  }, [runId, clearTicks]);

  /** "Skip all of these for now" — a deliberate no for every device on the screen. */
  const declineAllResets = useCallback((allIds: string[]) => {
    driverRef.current?.declineReset(allIds);
    setNeeds((n) => n.filter((x) => x.kind !== "reset_authorization"));
  }, []);

  /** "I don't know the password" — a complete answer, never a wall. */
  const dontKnowPassword = useCallback((phoneId: string) => {
    driverRef.current?.passwordUnknown(phoneId);
    setNeeds((n) => n.filter((x) => !(x.kind === "password" && x.phoneId === phoneId)));
  }, []);

  const supplyPassword = useCallback(async (phoneId: string, label: string) => {
    const pw = passwordDrafts[phoneId] ?? "";
    if (!pw.trim()) return;
    const bridge = desktop()?.phoneSetup;
    if (!bridge?.rememberCredential) return;
    // ⛔⛔ THE PASSWORD STAYS ON THIS COMPUTER. It goes into the app's own protected
    // store under a reference name; the server and the AI only ever see the
    // reference. That is the design, not a nicety — never post it to the api.
    const ref = `phone:${phoneId}`;
    const r = await bridge.rememberCredential(ref, "admin", pw).catch(() => null);
    if (r?.ok) {
      driverRef.current?.credentialStored(phoneId, ref);
      setPasswordDrafts((d) => { const { [phoneId]: _gone, ...rest } = d; return rest; });
      setNeeds((n) => n.filter((x) => !(x.kind === "password" && x.phoneId === phoneId)));
    } else {
      setError(`The password for ${label} could not be saved on this computer.`);
    }
  }, [passwordDrafts]);

  const assigned = useMemo(() => phones.filter((p) => p.extNumber), [phones]);
  const stepIndex = Math.max(0, STEP_ORDER.indexOf(step));

  return (
    <div className="dps-root">
      <div className="dps-wz">
        <div className="dps-wz-top">
          <span className="dps-t">Set up desk phones</span>
          <button
            type="button" onClick={onClose} aria-label="Close"
            style={{ marginLeft: "auto", background: "none", border: 0, color: "var(--dps-dim)", fontSize: 18, cursor: "pointer" }}
          >×</button>
        </div>
        <div className="dps-wz-steps" aria-hidden="true">
          {STEP_ORDER.map((s, i) => (
            <s key={s} className={i < stepIndex ? "dps-done" : i === stepIndex ? "dps-on" : ""} />
          ))}
        </div>

        {step === "welcome" && (
          <>
            <div className="dps-wz-body">
              <h3>Let&rsquo;s set up your desk phones</h3>
              <p className="dps-sub">
                Loopcom will look for the desk phones in your office and connect them to your account.
                It usually takes about five minutes, and we will tell you before anything on a phone changes.
              </p>
              <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 11 }}>
                <Check title="Your phones are plugged in and switched on" note="The screen is lit up, even if it says something like No service." />
                <Check title="They are in the same office as this computer" note="Same building, same internet." />
                <Check title="You can walk over to them if we ask" note="Usually we will not need to. Occasionally one phone needs a hand." />
              </div>
              {error && <p className="dps-hint" style={{ marginTop: 16, color: "var(--dps-warn)" }}>{error}</p>}
              {!hasDesktop && (
                <p className="dps-hint" style={{ marginTop: 16 }}>
                  Open this in the Loopcom app on a computer in the same office as your phones.
                </p>
              )}
            </div>
            <div className="dps-wz-foot">
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={start} disabled={busy}>Find My Phones</button>
            </div>
          </>
        )}

        {step === "knowPhone" && (
          <>
            <div className="dps-wz-body">
              <h3>Do you know what kind of phone you have?</h3>
              <p className="dps-sub">
                If you know, tell us and we will go straight to it. If you are not sure, that is completely
                fine &mdash; most people are not, and we will work it out ourselves.
              </p>
              <div className="dps-tiles">
                <button className={`dps-tile${knowsPhone === "yes" ? " dps-sel" : ""}`} onClick={() => setKnowsPhone("yes")}>
                  <b>Yes &mdash; I can see a name on it</b>
                  <span>There is usually a brand name printed under the screen, like Yealink, Polycom or Grandstream.</span>
                </button>
                {knowsPhone === "yes" && (
                  <input
                    className="dps-input"
                    style={{ gridColumn: "1 / -1" }}
                    placeholder="What does it say? e.g. Yealink T54W"
                    value={phoneNameHint}
                    onChange={(e) => setPhoneNameHint(e.target.value)}
                    aria-label="The name printed on your phone"
                  />
                )}
                <button className={`dps-tile${knowsPhone === "no" ? " dps-sel" : ""}`} onClick={() => setKnowsPhone("no")}>
                  <b>No &mdash; I have no idea</b>
                  <span>Perfectly normal. We will look for every kind of desk phone and show you a picture of each one we find.</span>
                </button>
              </div>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={() => setStep("welcome")}>Back</button>
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={() => setStep("connection")}>Continue</button>
            </div>
          </>
        )}

        {step === "connection" && (
          <>
            <div className="dps-wz-body">
              <h3>How are your phones connected?</h3>
              <p className="dps-sub">
                Look at the back of one phone. Which of these two does it look like? If you truly cannot tell,
                pick the last option and we will find out for you.
              </p>
              <div className="dps-tiles">
                <button className={`dps-tile${connection === "cable" ? " dps-sel" : ""}`} onClick={() => setConnection("cable")}>
                  <CableDrawing />
                  <b>There is a cable going into the back</b>
                  <span>A thin cable, a bit fatter than a phone cord, with a little clip on the end. This is how most office desk phones are connected.</span>
                </button>
                <button className={`dps-tile${connection === "wifi" ? " dps-sel" : ""}`} onClick={() => setConnection("wifi")}>
                  <WifiDrawing />
                  <b>No cable &mdash; it uses Wi&#8209;Fi</b>
                  <span>Only the power lead goes in. Less common on desk phones, but some newer models do this.</span>
                </button>
              </div>
              <button
                className={`dps-tile${connection === "unsure" ? " dps-sel" : ""}`}
                style={{ marginTop: 12, display: "block" }}
                onClick={() => setConnection("unsure")}
              >
                <b style={{ margin: 0 }}>I can&rsquo;t tell &mdash; just look for both</b>
                <span>We will search either way. This answer only helps us explain things better if a phone does not turn up.</span>
              </button>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={() => setStep("knowPhone")}>Back</button>
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={() => setStep("network")}>Continue</button>
            </div>
          </>
        )}

        {step === "network" && (
          <>
            <div className="dps-wz-body">
              <h3>One last thing before we look</h3>
              <p className="dps-sub">
                Your phones and this computer need to be on the same office internet. They almost always are
                &mdash; this is just so we know where to look.
              </p>
              <div style={{ margin: "20px 0 6px", padding: 18, borderRadius: 12, background: "var(--dps-panel-2)", border: "1px solid var(--dps-border)" }}>
                <SameNetworkDrawing />
              </div>
              <div style={{ display: "flex", gap: 9, alignItems: "center", marginTop: 14, padding: "11px 13px", borderRadius: 10, background: "color-mix(in srgb, var(--success, #34c27b) 11%, transparent)" }}>
                <span className="dps-tick" style={{ fontSize: 15 }}>&#10003;</span>
                <div style={{ font: "500 13.5px/1.5 Inter, sans-serif" }}>
                  This computer is on your office network. That is where we will look.
                </div>
              </div>
              <p className="dps-hint" style={{ marginTop: 12 }}>
                If any phones are in a different building, run this again on a computer in that building &mdash;
                we will only ever find the ones nearby.
              </p>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={() => setStep("connection")}>Back</button>
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={search}>Find My Phones</button>
            </div>
          </>
        )}

        {step === "searching" && (
          <div className="dps-wz-body">
            <div className="dps-radar">
              <span className="dps-ring" /><span className="dps-ring" /><span className="dps-ring" /><span className="dps-ring" />
              <span className="dps-core">
                <PhoneGlyph />
              </span>
            </div>
            <h3 style={{ textAlign: "center", fontSize: 22 }}>Looking for your phones&hellip;</h3>
            <p className="dps-sub" style={{ textAlign: "center", margin: "8px auto 0" }}>
              This takes about thirty seconds. You can leave this open and carry on working.
            </p>
            <div className="dps-scanline" style={{ marginTop: 20 }}><i /></div>
          </div>
        )}

        {(step === "found" || step === "match") && (
          <>
            <div className="dps-wz-body">
              {step === "found" ? (
                <>
                  <h3>{phones.length === 1 ? "We found 1 desk phone" : `We found ${phones.length} desk phones`}</h3>
                  <p className="dps-sub">
                    {phones.filter((p) => !p.needsAttention).length} ready to go
                    {phones.some((p) => p.needsAttention) ? ". Some will need a moment — we will explain those when we get to them." : "."}
                  </p>
                </>
              ) : (
                <>
                  <h3>Who uses each phone?</h3>
                  <p className="dps-sub">Pick the person who sits at each desk. Leave a phone blank to skip it for now.</p>
                </>
              )}
              {step === "found" && othersCount > 0 && (
                <p className="dps-hint" style={{ marginTop: 10 }}>
                  We also saw {othersCount} other {othersCount === 1 ? "device" : "devices"} on your network
                  &mdash; computers, printers and the like. We left those alone.
                </p>
              )}
              {step === "found" && phoneNameHint.trim() && phones.length > 0 && (
                <p className="dps-hint" style={{ marginTop: 6 }}>
                  You told us &ldquo;{phoneNameHint.trim()}&rdquo; &mdash; check the pictures below match what is on your desk.
                </p>
              )}
              {subnet && (
                <p className="dps-hint" style={{ marginTop: 10 }}>
                  We looked on this office&rsquo;s network. Phones in another building need this run again over there.
                </p>
              )}
              <div className="dps-plist">
                {phones.map((p) => (
                  <div key={p.id} className="dps-prow dps-found">
                    <div className="dps-pimg">
                      {photoFor(p.model)
                        ? <img src={photoFor(p.model)!} alt={p.model ? `${p.vendor ?? ""} ${p.model}`.trim() : "Desk phone"} />
                        : <PhoneGlyph />}
                    </div>
                    <div className="dps-pmeta">
                      <b>{[p.vendor, p.model].filter(Boolean).join(" ") || "Desk phone"}</b>
                      <span>{describe(p.model)}</span>
                    </div>
                    {step === "match" ? (
                      <select
                        className="dps-sel-ext"
                        value={extensions.find((e) => e.extNumber === p.extNumber)?.id ?? ""}
                        onChange={(e) => assign(p.id, e.target.value || null)}
                        aria-label="Who uses this phone"
                      >
                        <option value="">Choose a person&hellip;</option>
                        {extensions.map((e) => (
                          <option key={e.id} value={e.id}>{e.displayName} &mdash; {e.extNumber}</option>
                        ))}
                      </select>
                    ) : (
                      <span className={`dps-pill ${p.needsAttention ? "dps-pill-hm" : "dps-pill-ok"}`}>
                        {p.needsAttention ? "Needs attention" : "Ready"}
                      </span>
                    )}
                  </div>
                ))}
                {phones.length === 0 && (
                  <p className="dps-hint">
                    We did not find any desk phones on this office&rsquo;s network. Check they are switched on and
                    plugged in, then search again.
                    {/* ⛔ The connection answer earns its keep here — the copy on that
                        step promises "this answer only helps us explain things better
                        if a phone does not turn up", and this is that explanation. */}
                    {connection === "wifi" &&
                      " Wi-Fi phones sometimes join a guest network — check the phone is on the same Wi-Fi name as this computer."}
                    {connection === "cable" &&
                      " Follow the cable from one phone and make sure it goes to the same internet box this computer uses."}
                  </p>
                )}
              </div>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={step === "found" ? search : () => setStep("found")}>
                {step === "found" ? "Search again" : "Back"}
              </button>
              <span className="dps-hint">Nothing changes yet.</span>
              <span className="dps-sp" />
              <button
                className="dps-btn dps-btn-p"
                onClick={() => (step === "found" ? setStep("match") : setStep("ready"))}
                disabled={phones.length === 0}
              >Continue</button>
            </div>
          </>
        )}

        {step === "ready" && (
          <>
            <div className="dps-wz-body">
              <h3>Ready to set up your office</h3>
              <p className="dps-sub">
                {assigned.length} {assigned.length === 1 ? "phone is" : "phones are"} matched to a person.
                Some may restart along the way &mdash; the rest keep working the whole time.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 11, marginTop: 20 }}>
                <Stat n={String(assigned.length)} label="phones to set up" />
                <Stat n="~4" label="minutes, roughly" />
              </div>
              <p className="dps-hint" style={{ marginTop: 16 }}>
                If somebody is on a call right now, that phone waits its turn.
              </p>
            </div>
            <div className="dps-wz-foot">
              <button className="dps-btn dps-btn-g" onClick={() => setStep("match")}>Back</button>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={beginSetup} disabled={assigned.length === 0}>
                Set Up {assigned.length} {assigned.length === 1 ? "Phone" : "Phones"}
              </button>
            </div>
          </>
        )}

        {/*
          ⛔⛔ THE TWO PERSON-ONLY MOMENTS ARE FULL SCREENS, ONE QUESTION AT A TIME.
          Izzy saw the compact card version and said even he took a second to find
          it — "dumb people will just get stuck here". So when a decision is needed,
          the wizard STOPS: no progress list, no competing information, one big
          question, big buttons, and a way out that is not a wall.
        */}
        {step === "live" && needs.some((n) => n.kind === "reset_authorization") && (() => {
          const n: any = needs.find((x) => x.kind === "reset_authorization");
          const items = phones.filter((p) => n.phoneIds.includes(p.id));
          const tickedCount = n.phoneIds.filter((id: string) => clearTicks[id] !== false).length;
          return (
            <>
              <div className="dps-wz-body">
                <h3>{items.length === 1 ? "One phone needs a fresh start" : `${items.length} phones need a fresh start`}</h3>
                <p className="dps-sub">
                  These still have your <b>old phone company&rsquo;s</b> settings inside. To join Loopcom,
                  we wipe the old settings off. That is all &mdash; your numbers, voicemails and
                  everything in Loopcom are not touched.
                </p>
                <div className="dps-plist" style={{ marginTop: 16 }}>
                  {(items.length ? items : n.phoneIds.map((id: string) => ({ id, model: null, vendor: null, displayName: null, extNumber: null }))).map((p: any) => (
                    <label key={p.id} className="dps-prow dps-clear-row">
                      <input
                        type="checkbox"
                        className="dps-check"
                        checked={clearTicks[p.id] !== false}
                        onChange={(e) => setClearTicks((t) => ({ ...t, [p.id]: e.target.checked }))}
                        aria-label={`Clear ${p.displayName || p.model || "this device"}`}
                      />
                      <div className="dps-pimg">
                        {photoFor(p.model) ? <img src={photoFor(p.model)!} alt="" /> : <PhoneGlyph />}
                      </div>
                      <div className="dps-pmeta">
                        <b>{p.displayName ? `${p.displayName}${p.extNumber ? ` — ${p.extNumber}` : ""}` : (p.model ?? "Device")}</b>
                        <span>{describe(p.model)}</span>
                      </div>
                      <span className="dps-hint">{clearTicks[p.id] !== false ? "Will be cleaned" : "Left alone"}</span>
                    </label>
                  ))}
                </div>
                <p className="dps-hint" style={{ marginTop: 12 }}>
                  Untick any you want left exactly as it is. Each one restarts once and takes about two minutes.
                </p>
                {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginTop: 10 }}>{error}</p>}
              </div>
              <div className="dps-wz-foot">
                <button className="dps-btn dps-btn-g" onClick={() => declineAllResets(n.phoneIds)}>
                  Skip all of these for now
                </button>
                <span className="dps-sp" />
                <button className="dps-btn dps-btn-p dps-btn-big" onClick={() => approveReset(n.phoneIds)}>
                  {tickedCount === 0 ? "Continue without cleaning" :
                    tickedCount === 1 ? "Clean 1 phone — go ahead" : `Clean ${tickedCount} phones — go ahead`}
                </button>
              </div>
            </>
          );
        })()}

        {step === "live" && !needs.some((n) => n.kind === "reset_authorization") && needs.some((n) => n.kind === "password") && (() => {
          const n: any = needs.find((x) => x.kind === "password");
          return (
            <>
              <div className="dps-wz-body">
                <h3>{n.label} is locked with a password</h3>
                <p className="dps-sub">
                  Your old phone company put a password on this one. If you have it, type it in
                  and we do the rest. <b>If you don&rsquo;t have it, that is completely fine</b> &mdash;
                  press the other button and Loopcom will sort it out for you.
                </p>
                <div className="dps-ask" style={{ marginTop: 18 }}>
                  <b>Where would the password be?</b>
                  <p>Sometimes it is on a sticker under the phone. Sometimes it is in an old email
                  from your previous phone company. If you are not sure, don&rsquo;t dig &mdash; just press
                  &ldquo;I don&rsquo;t know it&rdquo;.</p>
                  <div className="dps-ask-row">
                    <input
                      type="password"
                      className="dps-input"
                      placeholder="Type the password here"
                      value={passwordDrafts[n.phoneId] ?? ""}
                      onChange={(e) => setPasswordDrafts((d) => ({ ...d, [n.phoneId]: e.target.value }))}
                      aria-label={`Password for ${n.label}`}
                    />
                    <button className="dps-btn dps-btn-p" onClick={() => supplyPassword(n.phoneId, n.label)}>Use it</button>
                  </div>
                  <span className="dps-hint">The password stays on this computer. It is never sent to Loopcom.</span>
                </div>
                {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginTop: 10 }}>{error}</p>}
              </div>
              <div className="dps-wz-foot">
                <button className="dps-btn dps-btn-g dps-btn-big" onClick={() => dontKnowPassword(n.phoneId)}>
                  I don&rsquo;t know it — Loopcom can sort this one out
                </button>
                <span className="dps-sp" />
              </div>
            </>
          );
        })()}

        {step === "live" && !needs.length && (
          <div className="dps-wz-body">
            <div style={{ display: "flex", alignItems: "baseline", gap: 11, marginBottom: 11 }}>
              <div style={{ font: "700 22px/1 Inter, sans-serif", letterSpacing: "-0.025em" }}>
                {summary?.headline ?? "Setting up your office"}
              </div>
            </div>
            {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginBottom: 10 }}>{error}</p>}
            <div className="dps-bar">
              <i style={{ width: `${summary && summary.total ? Math.round((summary.ready / summary.total) * 100) : 0}%` }} />
            </div>
            <div className="dps-plist">
              {phones.map((p) => (
                <div key={p.id} className="dps-prow">
                  <div className="dps-pimg">
                    {photoFor(p.model) ? <img src={photoFor(p.model)!} alt="" /> : <PhoneGlyph />}
                  </div>
                  <div className="dps-pmeta">
                    <b>{p.displayName ? `${p.displayName} — ${p.extNumber}` : (p.model ?? "Desk phone")}</b>
                    {p.note && <span>{p.note}</span>}
                  </div>
                  <span className={`dps-pill ${p.status === "Ready" ? "dps-pill-ok" : p.needsAttention ? "dps-pill-hm" : "dps-pill-br"}`}>
                    {p.status !== "Ready" && !p.needsAttention && <span className="dps-spin" style={{ marginRight: 5 }} />}
                    {p.status}
                  </span>
                </div>
              ))}
            </div>
            <p className="dps-hint" style={{ marginTop: 14 }}>
              {/* ⛔ Honest: the office machine is doing the work, so the window has to
                  stay open. Saying "you can close this" here would quietly stop the
                  setup the moment somebody believed it. */}
              Keep this window open while we work &mdash; you can carry on using your computer.
            </p>
          </div>
        )}

        {step === "done" && summary && (
          <>
            <div className="dps-wz-body" style={{ textAlign: "center", paddingTop: 34 }}>
              <div
                className="dps-found"
                style={{
                  width: 62, height: 62, borderRadius: "50%", display: "grid", placeItems: "center",
                  margin: "0 auto 18px", background: "color-mix(in srgb, var(--success, #34c27b) 17%, transparent)",
                }}
              >
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
                     strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--dps-ok)" }} aria-hidden="true">
                  <path d="M4.5 12.5l5 5 10-11" />
                </svg>
              </div>
              <h3 style={{ fontSize: 26 }}>{summary.headline}</h3>
              <p className="dps-sub" style={{ margin: "9px auto 0" }}>
                {summary.needsAttention === 0
                  ? "Try picking one up — you should hear a dial tone."
                  : "Your office is working. The rest can wait until you have a minute."}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(158px,1fr))", gap: 8, marginTop: 22, textAlign: "left" }}>
                {phones.map((p) => (
                  <div key={p.id} className="dps-st">
                    <span className={p.status === "Ready" ? "dps-tick" : ""}>{p.status === "Ready" ? "✓" : "⚠"}</span>{" "}
                    {p.displayName ?? p.model ?? "Desk phone"}
                  </div>
                ))}
              </div>
            </div>
            <div className="dps-wz-foot">
              <span className="dps-hint">Everything is saved.</span>
              <span className="dps-sp" />
              <button className="dps-btn dps-btn-p" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Check({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
      <span className="dps-tick">&#10003;</span>
      <div>
        <b style={{ font: "600 13.5px Inter, sans-serif" }}>{title}</b>
        <div className="dps-hint">{note}</div>
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div style={{ padding: "15px 16px", borderRadius: 11, background: "var(--dps-panel-2)", border: "1px solid var(--dps-border)" }}>
      <div style={{ font: "700 27px/1 Inter, sans-serif", letterSpacing: "-0.03em" }}>{n}</div>
      <div className="dps-hint" style={{ marginTop: 4 }}>{label}</div>
    </div>
  );
}

function PhoneGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         style={{ color: "var(--dps-accent)" }} aria-hidden="true">
      <rect x="4" y="2" width="16" height="20" rx="2.5" />
      <rect x="7.5" y="5" width="9" height="4.5" rx="1" />
      <circle cx="9" cy="14" r="1" /><circle cx="12" cy="14" r="1" /><circle cx="15" cy="14" r="1" />
    </svg>
  );
}

/* ⛔ Drawn, not described. "Ethernet" means nothing to most people; a picture of a
   cable going into a box does. Ported from the approved mockup. */
function CableDrawing() {
  return (
    <svg width="100%" height="128" viewBox="0 0 280 128" fill="none" role="img"
         aria-label="A desk phone with a network cable running into the office internet box">
      <DrawnPhone x={14} y={22} stroke="var(--dps-accent)" />
      <text x="42" y="106" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">your phone</text>
      <path d="M70 62 H190" stroke="var(--dps-accent)" strokeWidth="3.6" strokeLinecap="round" />
      <circle cx="70" cy="62" r="4" fill="var(--dps-accent)" />
      <circle cx="190" cy="62" r="4" fill="var(--dps-accent)" />
      <text x="130" y="52" fontSize="11.5" fontWeight="600" fill="var(--dps-accent)" textAnchor="middle">a cable</text>
      <DrawnRouter x={190} y={46} stroke="var(--dps-accent)" />
      <text x="228" y="106" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">internet box</text>
    </svg>
  );
}

function WifiDrawing() {
  return (
    <svg width="100%" height="128" viewBox="0 0 280 128" fill="none" role="img"
         aria-label="A desk phone connecting to the office internet box over Wi-Fi, with no cable">
      <DrawnPhone x={14} y={22} stroke="var(--dps-dim)" />
      <text x="42" y="106" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">your phone</text>
      <g stroke="var(--dps-dim)" strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d="M84 72 a 15 15 0 0 1 0 -20" /><path d="M96 79 a 27 27 0 0 0 0 -34" />
        <path d="M186 72 a 15 15 0 0 0 0 -20" /><path d="M174 79 a 27 27 0 0 1 0 -34" />
      </g>
      <text x="135" y="46" fontSize="11.5" fontWeight="600" fill="var(--dps-dim)" textAnchor="middle">no cable</text>
      <DrawnRouter x={190} y={46} stroke="var(--dps-dim)" />
      <text x="228" y="106" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">internet box</text>
    </svg>
  );
}

function SameNetworkDrawing() {
  const A = "var(--dps-accent)";
  return (
    <svg width="100%" height="200" viewBox="0 0 440 200" fill="none" role="img"
         aria-label="This computer and the desk phones all connect to the same office internet box">
      <DrawnRouter x={168} y={18} stroke={A} wide />
      <text x="220" y="74" fontSize="12" fontWeight="600" fill={A} textAnchor="middle">Your office internet</text>
      <g stroke={A} strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path d="M220 56 v30" /><path d="M70 86 H352" />
        <path d="M70 86 v18" /><path d="M294 86 v18" /><path d="M352 86 v18" />
      </g>
      <g stroke={A} strokeWidth="1.8" fill="none">
        <rect x="34" y="104" width="72" height="46" rx="4" fill="var(--dps-panel)" />
        <rect x="40" y="110" width="60" height="30" rx="2" fill={A} opacity=".2" stroke="none" />
        <path d="M64 150 v9 M76 150 v9" strokeLinecap="round" /><path d="M48 160 h44" strokeLinecap="round" />
      </g>
      <text x="70" y="188" fontSize="11.5" fill="var(--dps-dim)" textAnchor="middle">This computer</text>
      <DrawnPhone x={266} y={104} stroke={A} />
      <DrawnPhone x={324} y={104} stroke={A} />
      <text x="323" y="188" fontSize="11.5" fill="var(--dps-dim)" textAnchor="middle">Your desk phones</text>
    </svg>
  );
}

function DrawnPhone({ x, y, stroke }: { x: number; y: number; stroke: string }) {
  return (
    <g stroke={stroke} strokeWidth="1.8" fill="none">
      <rect x={x} y={y + 10} width="56" height="56" rx="5" fill="var(--dps-panel)" />
      <rect x={x - 4} y={y} width="64" height="13" rx="6" fill="var(--dps-panel)" />
      <rect x={x + 9} y={y + 18} width="38" height="16" rx="2" fill={stroke} opacity=".22" stroke="none" />
      <g fill={stroke} opacity=".5" stroke="none">
        <circle cx={x + 15} cy={y + 43} r="2.4" /><circle cx={x + 28} cy={y + 43} r="2.4" /><circle cx={x + 41} cy={y + 43} r="2.4" />
        <circle cx={x + 15} cy={y + 54} r="2.4" /><circle cx={x + 28} cy={y + 54} r="2.4" /><circle cx={x + 41} cy={y + 54} r="2.4" />
      </g>
    </g>
  );
}

function DrawnRouter({ x, y, stroke, wide }: { x: number; y: number; stroke: string; wide?: boolean }) {
  const w = wide ? 104 : 76;
  const h = wide ? 38 : 32;
  return (
    <g stroke={stroke} strokeWidth="1.8" fill="none">
      <rect x={x} y={y} width={w} height={h} rx="6" fill="var(--dps-panel)" />
      <path d={`M${x + 18} ${y} v-12`} strokeLinecap="round" />
      <path d={`M${x + w - 18} ${y} v-16`} strokeLinecap="round" />
      <g stroke="none">
        <circle cx={x + 14} cy={y + h / 2} r="2.5" fill="var(--success, #34c27b)" />
        <circle cx={x + 24} cy={y + h / 2} r="2.5" fill="var(--success, #34c27b)" />
      </g>
    </g>
  );
}
