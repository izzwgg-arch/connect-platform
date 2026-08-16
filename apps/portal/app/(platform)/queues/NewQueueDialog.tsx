"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { apiGet, apiPost } from "../../../services/apiClient";
import { useUiLanguage } from "../../../hooks/useUiLanguage";

/**
 * Create a queue from the Queues screen.
 *
 * Two rules from Izzy, recorded in the panel contract doc, shape this form:
 * mainstream options up front and the complicated ones under Advanced, and
 * BOTH explained in plain language. So every control here says what it does to
 * a caller, not what it is called in Asterisk.
 *
 * ⛔ It posts to the EXISTING `POST /voice/teams`, the same path the IVR Studio
 * uses. There is no second creation route — that is how the two IVR publish
 * paths drifted apart, and it is not being repeated here.
 *
 * ⛔ Apply Changes is never fired. A new queue exists on the phone system but
 * does not carry calls until someone presses Apply Changes on the PBX, and the
 * form says so before you submit rather than after.
 */

export type ExtensionOption = { extension: string; name: string | null };

/** Byte-exact strings, so every one of them reaches Yiddish. */
export const NEW_QUEUE_PHRASES = [
  "New queue", "Create a queue", "Cancel", "Create queue", "Creating…",
  "What is it called?", "Sales, Support, Phone Orders — whatever your team calls it.",
  "Who's in it?", "Tick everyone whose phone should ring for this queue.",
  "No extensions found on your phone system.",
  "How should it ring?", "Everyone at once", "One at a time, in order",
  "Longest idle first", "Fewest calls first", "Random", "Round robin",
  "Round robin, in order", "Weighted random",
  "How long does each phone ring?", "seconds", "Wait between rounds",
  "Tell callers their place in line", "Most callers allowed to wait",
  "0 means no limit", "Longest anyone waits", "0 means no limit — they wait until someone answers",
  "Advanced", "Hide advanced", "Show advanced",
  "Answer target", "Reports measure this queue against this many seconds.",
  "Rest after a call", "Seconds before this queue rings the same person again.",
  "Let callers in when nobody is logged on",
  "Send waiting callers away if everyone logs off",
  "Pause an agent who doesn't answer",
  "Wait before connecting", "Priority when someone is on several queues",
  "Repeat their place in line every", "Never repeat more often than",
  "Stop announcing past place", "Round the wait time to",
  "Distinctive ring", "Alert-Info sent to the handsets, if yours support it.",
  "Where callers go if nobody answers", "Nowhere — just hang up",
  "This queue will be number", "It won't take calls until Apply Changes is pressed on the phone system.",
  "Queue created", "was created and is waiting for Apply Changes on the phone system.",
  "Give the queue a name.", "Pick at least one person.",
  "Couldn't create the queue.",
] as const;

const STRATEGIES: Array<{ value: string; label: string }> = [
  { value: "ringall", label: "Everyone at once" },
  { value: "linear", label: "One at a time, in order" },
  { value: "leastrecent", label: "Longest idle first" },
  { value: "fewestcalls", label: "Fewest calls first" },
  { value: "rrmemory", label: "Round robin" },
  { value: "rrordered", label: "Round robin, in order" },
  { value: "random", label: "Random" },
  { value: "wrandom", label: "Weighted random" },
];

export function NewQueueDialog({
  extensions,
  onClose,
  onCreated,
}: {
  extensions: ExtensionOption[];
  onClose: () => void;
  onCreated: (msg: string) => void;
}) {
  const { t } = useUiLanguage(NEW_QUEUE_PHRASES as unknown as string[]);

  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [strategy, setStrategy] = useState("ringall");
  const [ringTime, setRingTime] = useState(15);
  const [retry, setRetry] = useState(5);
  const [announcePosition, setAnnouncePosition] = useState(false);
  const [maxCallers, setMaxCallers] = useState(0);
  const [maxWait, setMaxWait] = useState(0);

  const [advanced, setAdvanced] = useState(false);
  const [serviceLevel, setServiceLevel] = useState(20);
  const [wrapUp, setWrapUp] = useState(0);
  const [joinWhenEmpty, setJoinWhenEmpty] = useState(true);
  const [leaveWhenEmpty, setLeaveWhenEmpty] = useState(false);
  const [autoPause, setAutoPause] = useState(false);
  const [memberDelay, setMemberDelay] = useState(0);
  const [weight, setWeight] = useState(0);
  const [announceFreq, setAnnounceFreq] = useState(0);
  const [minAnnounceFreq, setMinAnnounceFreq] = useState(0);
  const [announcePosLimit, setAnnouncePosLimit] = useState(0);
  const [announceRound, setAnnounceRound] = useState(0);
  const [alertInfo, setAlertInfo] = useState("");
  const [lastDest, setLastDest] = useState("");

  const [nextNumber, setNextNumber] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Show the number it WILL get before anyone commits — nobody should have to
  // guess what callers will be told to dial.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ number?: string }>("/voice/teams/next-number?kind=queue")
      .then((j) => { if (!cancelled) setNextNumber(j?.number ?? null); })
      .catch(() => { /* the number is nice to know, not required to submit */ });
    return () => { cancelled = true; };
  }, []);

  const toggleMember = (ext: string) =>
    setMembers((prev) => (prev.includes(ext) ? prev.filter((x) => x !== ext) : [...prev, ext]));

  const canSubmit = name.trim().length > 0 && members.length > 0 && !saving;

  const submit = async () => {
    // ⛔ Refuse loudly at the control that was pressed. A disabled button with
    // no reason on screen is how an hour of work ends in a dead end.
    if (!name.trim()) { setErr(t("Give the queue a name.")); return; }
    if (members.length === 0) { setErr(t("Pick at least one person.")); return; }

    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        kind: "queue",
        name: name.trim(),
        members,
        queueStrategy: strategy,
        ringTime,
        retry,
        announcePosition,
        maxCallers,
        maxWaitSeconds: maxWait,
        // Advanced — sent always; the defaults match what the form shows.
        serviceLevelSeconds: serviceLevel > 0 ? serviceLevel : undefined,
        wrapUpSeconds: wrapUp,
        joinWhenEmpty,
        leaveWhenEmpty,
        autoPause,
        memberDelaySeconds: memberDelay,
        weight,
        announceFrequency: announceFreq,
        minAnnounceFrequency: minAnnounceFreq,
        announcePositionLimit: announcePosLimit,
        announceRoundSeconds: announceRound,
        alertInfo: alertInfo.trim() || undefined,
        ...(lastDest ? { lastDestination: { kind: "extension", target: lastDest } } : {}),
      };
      const res = await apiPost<{ number?: string; name?: string }>("/voice/teams", body);
      onCreated(`${t("Queue created")} — ${res?.number ?? ""} ${name.trim()} ${t("was created and is waiting for Apply Changes on the phone system.")}`);
      onClose();
    } catch (e: any) {
      setErr(e?.body?.message || e?.body?.detail || e?.message || t("Couldn't create the queue."));
    } finally {
      setSaving(false);
    }
  };

  const people = useMemo(
    () => extensions.slice().sort((a, b) => a.extension.localeCompare(b.extension)),
    [extensions],
  );

  return (
    <div className="qb-modal-backdrop" role="dialog" aria-modal="true" aria-label={t("Create a queue")}>
      <div className="qb-modal">
        <header className="qb-modal-h">
          <h2>{t("Create a queue")}</h2>
          <button type="button" className="qb-ctl-x" onClick={onClose} aria-label={t("Cancel")}>
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className="qb-modal-body">
          <Field label={t("What is it called?")} hint={t("Sales, Support, Phone Orders — whatever your team calls it.")}>
            <input className="qb-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>

          <Field label={t("Who's in it?")} hint={t("Tick everyone whose phone should ring for this queue.")}>
            {people.length === 0 ? (
              <p className="qb-hint">{t("No extensions found on your phone system.")}</p>
            ) : (
              <ul className="qb-picker">
                {people.map((p) => (
                  <li key={p.extension}>
                    <label className="qb-check">
                      <input
                        type="checkbox"
                        checked={members.includes(p.extension)}
                        onChange={() => toggleMember(p.extension)}
                      />
                      <span className="qb-ext">{p.extension}</span>
                      {p.name && <span className="qb-dim">{p.name}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </Field>

          <Field label={t("How should it ring?")}>
            <select className="qb-input" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>{t(s.label)}</option>
              ))}
            </select>
          </Field>

          <div className="qb-fieldrow">
            <NumField label={t("How long does each phone ring?")} unit={t("seconds")} value={ringTime} onChange={setRingTime} min={0} max={300} />
            <NumField label={t("Wait between rounds")} unit={t("seconds")} value={retry} onChange={setRetry} min={0} max={120} />
          </div>

          <label className="qb-check qb-check-row">
            <input type="checkbox" checked={announcePosition} onChange={(e) => setAnnouncePosition(e.target.checked)} />
            <span>{t("Tell callers their place in line")}</span>
          </label>

          <div className="qb-fieldrow">
            <NumField label={t("Most callers allowed to wait")} hint={t("0 means no limit")} value={maxCallers} onChange={setMaxCallers} min={0} max={999} />
            <NumField label={t("Longest anyone waits")} unit={t("seconds")} hint={t("0 means no limit — they wait until someone answers")} value={maxWait} onChange={setMaxWait} min={0} max={7200} />
          </div>

          <Field label={t("Where callers go if nobody answers")}>
            <select className="qb-input" value={lastDest} onChange={(e) => setLastDest(e.target.value)}>
              <option value="">{t("Nowhere — just hang up")}</option>
              {people.map((p) => (
                <option key={p.extension} value={p.extension}>
                  {p.extension}{p.name ? ` — ${p.name}` : ""}
                </option>
              ))}
            </select>
          </Field>

          <button type="button" className="qb-disclosure" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
            {advanced ? t("Hide advanced") : t("Show advanced")}
          </button>

          {advanced && (
            <div className="qb-advanced">
              <div className="qb-fieldrow">
                <NumField label={t("Answer target")} unit={t("seconds")} hint={t("Reports measure this queue against this many seconds.")} value={serviceLevel} onChange={setServiceLevel} min={0} max={3600} />
                <NumField label={t("Rest after a call")} unit={t("seconds")} hint={t("Seconds before this queue rings the same person again.")} value={wrapUp} onChange={setWrapUp} min={0} max={3600} />
              </div>

              <label className="qb-check qb-check-row">
                <input type="checkbox" checked={joinWhenEmpty} onChange={(e) => setJoinWhenEmpty(e.target.checked)} />
                <span>{t("Let callers in when nobody is logged on")}</span>
              </label>
              <label className="qb-check qb-check-row">
                <input type="checkbox" checked={leaveWhenEmpty} onChange={(e) => setLeaveWhenEmpty(e.target.checked)} />
                <span>{t("Send waiting callers away if everyone logs off")}</span>
              </label>
              <label className="qb-check qb-check-row">
                <input type="checkbox" checked={autoPause} onChange={(e) => setAutoPause(e.target.checked)} />
                <span>{t("Pause an agent who doesn't answer")}</span>
              </label>

              <div className="qb-fieldrow">
                <NumField label={t("Wait before connecting")} unit={t("seconds")} value={memberDelay} onChange={setMemberDelay} min={0} max={60} />
                <NumField label={t("Priority when someone is on several queues")} value={weight} onChange={setWeight} min={0} max={99} />
              </div>
              <div className="qb-fieldrow">
                <NumField label={t("Repeat their place in line every")} unit={t("seconds")} value={announceFreq} onChange={setAnnounceFreq} min={0} max={3600} />
                <NumField label={t("Never repeat more often than")} unit={t("seconds")} value={minAnnounceFreq} onChange={setMinAnnounceFreq} min={0} max={3600} />
              </div>
              <div className="qb-fieldrow">
                <NumField label={t("Stop announcing past place")} value={announcePosLimit} onChange={setAnnouncePosLimit} min={0} max={999} />
                <NumField label={t("Round the wait time to")} unit={t("seconds")} value={announceRound} onChange={setAnnounceRound} min={0} max={60} />
              </div>

              <Field label={t("Distinctive ring")} hint={t("Alert-Info sent to the handsets, if yours support it.")}>
                <input className="qb-input" value={alertInfo} onChange={(e) => setAlertInfo(e.target.value)} maxLength={60} />
              </Field>
            </div>
          )}

          {nextNumber && (
            <p className="qb-hint qb-hint-strong">
              {t("This queue will be number")} <b>{nextNumber}</b>. {t("It won't take calls until Apply Changes is pressed on the phone system.")}
            </p>
          )}

          {err && <p className="qb-notice qb-notice-warn">{err}</p>}
        </div>

        <footer className="qb-modal-f">
          <button type="button" className="qb-btn" onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className="qb-btn qb-btn-primary" onClick={submit} disabled={!canSubmit}>
            {saving ? t("Creating…") : t("Create queue")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="qb-field">
      <label className="qb-label">{label}</label>
      {children}
      {hint && <p className="qb-hint">{hint}</p>}
    </div>
  );
}

function NumField({
  label, unit, hint, value, onChange, min, max,
}: {
  label: string; unit?: string; hint?: string;
  value: number; onChange: (v: number) => void; min: number; max: number;
}) {
  return (
    <div className="qb-field">
      <label className="qb-label">{label}</label>
      <div className="qb-numwrap">
        <input
          className="qb-input qb-input-num"
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min);
          }}
        />
        {unit && <span className="qb-unit">{unit}</span>}
      </div>
      {hint && <p className="qb-hint">{hint}</p>}
    </div>
  );
}
