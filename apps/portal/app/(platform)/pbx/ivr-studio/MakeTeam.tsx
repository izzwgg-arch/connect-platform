"use client";

// ── Making a team ────────────────────────────────────────────────────────────
//
// "Team" is one idea to the person setting it up — several phones ring instead
// of one — and two different objects on the phone system. Rather than ask which
// they want in jargon, this asks what should happen to callers and picks:
//
//   ring group → the phones ring; if nobody answers the caller goes somewhere.
//   queue      → the caller WAITS, hears music, and is answered in turn.
//
// Everything mainstream is on the front screen. Everything fiddly lives under
// "More options", closed, with the same plain wording — because someone who
// needs "wrap-up time" knows to go looking, and someone who doesn't should
// never have to see it.
//
// Members are drag-ordered. For "one at a time" that order IS the ring order,
// which is why the list is reorderable rather than a set of checkboxes.

import { useEffect, useMemo, useState } from "react";
import { useUiLanguage } from "../../../../hooks/useUiLanguage";

/** Registered up front so the whole screen arrives translated at once, rather
 *  than switching to Yiddish a phrase at a time as the customer clicks. */
const PHRASES = [
  "Ring more than one phone", "Two ways to do it. Pick what should happen to the caller.",
  "Ring a few phones",
  "Several phones ring. Whoever picks up first gets the call. If nobody answers, the caller goes wherever you choose - usually voicemail.",
  "Best for a small team answering their own calls.",
  "Put callers in a line",
  "Callers wait, hear music, and are answered in the order they called. You can tell them where they are in the line.",
  "Best when you get more calls than people to answer them.",
  "The difference in one sentence: with a group the caller either gets answered or moves on; in a line the caller waits.",
  "New waiting line", "New ring group", "Back", "Create it", "Setting up...",
  "What should it be called?", "Just for you - callers never hear it.",
  "Who's in it?", "Tick everyone whose phone should be involved.", "No extensions set up yet.",
  "Order they're offered calls", "Ring order",
  "Drag to reorder. The person at the top is offered a waiting caller first.",
  "Drag to reorder. Phones ring one at a time, from the top down.",
  "All these phones ring together, so the order doesn't matter unless you switch to one at a time below.",
  "How should they ring?", "All at once", "Every phone rings together. Fastest to answer.",
  "One at a time", "Rings the first person, then the next, and so on. Use when someone should always get first refusal.",
  "How long each person's phone rings", "How long to keep ringing",
  "If they don't pick up in this time, the call is offered to the next person.",
  "After this, the caller goes wherever you choose below. Around 20 seconds is four or five rings.",
  "If nobody answers, then what?", "Take a message", "The caller reaches voicemail and can leave a message.",
  "Ring one more person", "Try someone else - an owner or a mobile - before giving up.", "Choose...",
  "While they wait", "Tell them their place in the line",
  "“You are third in line.” People wait longer when they know where they are.",
  "Say something every so often",
  "A short message on repeat - “Thanks for holding, we'll be with you shortly.”",
  "Never", "Play it over the music", "The music keeps going underneath. Sounds more natural.",
  "Stop the music while it plays", "The message gets the caller's full attention. Use for something important.",
  "More options", "Show something on the phone screen",
  "Put in front of the caller's name on your handset, so you can tell which line rang before you pick up. Left blank, the team's name is used.",
  "Gap before trying again", "None", "A breather after a full round, so phones aren't ringing non-stop.",
  "Most callers allowed to wait",
  "0 means no limit. Above this, extra callers are sent on rather than joining a line they'll never get through.",
  "Longest anyone should wait",
  "In seconds. 0 means no limit. After this the caller stops waiting and goes wherever you chose above.",
  "This is set up on your phone system straight away, and starts taking calls the next time changes are applied.",
  "Couldn't set that up.",
];

export type TeamKind = "ring_group" | "queue";

// Matches the Studio's directory shape: an extension can genuinely have no
// name on the PBX, and every place below already falls back to the number.
interface Person { extension: string; name?: string | null }

export interface MadeTeam { kind: TeamKind; number: string; name: string; memberCount: number }

export function MakeTeam({
  people,
  tenantQs,
  apiBase,
  authToken,
  onCreated,
  onClose,
}: {
  people: Person[];
  tenantQs: string;
  apiBase: string;
  authToken: string;
  onCreated: (team: MadeTeam, message: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<TeamKind | null>(null);
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<"ringall" | "one_by_one">("ringall");
  const [ringTime, setRingTime] = useState(20);
  const [lastDest, setLastDest] = useState<{ kind: "extension" | "voicemail"; target: string } | null>(null);

  // queue-only
  const [retry, setRetry] = useState(5);
  const [announcePosition, setAnnouncePosition] = useState(false);
  const [periodicSeconds, setPeriodicSeconds] = useState(0);
  const [overMusic, setOverMusic] = useState(true);
  const [maxCallers, setMaxCallers] = useState(0);
  const [maxWait, setMaxWait] = useState(0);

  const [advanced, setAdvanced] = useState(false);
  const [nextNumber, setNextNumber] = useState<string | null>(null);
  const [numberWhy, setNumberWhy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const { t } = useUiLanguage(PHRASES);

  const api = useMemo(
    () => async (path: string, init?: RequestInit) => {
      const r = await fetch(`${apiBase}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json", ...(init?.headers || {}) },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.message || body?.error || `Request failed (${r.status})`);
      return body;
    },
    [apiBase, authToken],
  );

  // Show the number it WILL get before anyone commits. Someone about to create
  // a team should not have to guess what callers will be told to dial.
  useEffect(() => {
    if (!kind) return;
    let cancelled = false;
    (async () => {
      try {
        const sep = tenantQs ? "&" : "?";
        const j = await api(`/voice/teams/next-number${tenantQs}${sep}kind=${kind}`);
        if (cancelled) return;
        setNextNumber(j.number ?? null);
        setNumberWhy(j.why ?? null);
      } catch {
        if (!cancelled) { setNextNumber(null); setNumberWhy(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [kind, tenantQs, api]);

  function toggleMember(ext: string) {
    setMembers((m) => (m.includes(ext) ? m.filter((x) => x !== ext) : [...m, ext]));
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= members.length) return;
    setMembers((m) => {
      const next = [...m];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    });
  }

  async function save() {
    if (!kind) return;
    setErr(null); setSaving(true);
    try {
      const body: Record<string, unknown> = {
        kind,
        name: name.trim(),
        prefix: prefix.trim() || undefined,
        members,
        ringTime,
        lastDestination: lastDest ?? undefined,
      };
      if (kind === "ring_group") {
        body.strategy = strategy;
      } else {
        body.retry = retry;
        body.announcePosition = announcePosition;
        if (periodicSeconds > 0) {
          body.periodicAnnounceFrequency = periodicSeconds;
          body.relativePeriodicAnnounce = !overMusic;
        }
        if (maxCallers > 0) body.maxCallers = maxCallers;
        if (maxWait > 0) body.maxWaitSeconds = maxWait;
      }
      const j = await api(`/voice/teams${tenantQs}`, { method: "POST", body: JSON.stringify(body) });
      onCreated(j.team, j.message);
    } catch (e: any) {
      setErr(e?.message || t("Couldn't set that up."));
    } finally {
      setSaving(false);
    }
  }

  const nameFor = (ext: string) => people.find((p) => p.extension === ext)?.name || `Extension ${ext}`;
  const canSave = Boolean(kind && name.trim() && members.length > 0 && !saving);

  // ── Screen 1: which kind, asked as what callers experience ────────────────
  if (!kind) {
    return (
      <Shell title={t("Ring more than one phone")} sub={t("Two ways to do it. Pick what should happen to the caller.")} onClose={onClose}>
        <button className="mt-pick" onClick={() => { setKind("ring_group"); setName("Sales team"); }}>
          <span className="mt-pick-glyph" aria-hidden>📳</span>
          <span>
            <b>{t("Ring a few phones")}</b>
            <i>{t("Several phones ring. Whoever picks up first gets the call. If nobody answers, the caller goes wherever you choose - usually voicemail.")}</i>
            <u>{t("Best for a small team answering their own calls.")}</u>
          </span>
        </button>
        <button className="mt-pick" onClick={() => { setKind("queue"); setName("Support line"); }}>
          <span className="mt-pick-glyph" aria-hidden>⏳</span>
          <span>
            <b>{t("Put callers in a line")}</b>
            <i>{t("Callers wait, hear music, and are answered in the order they called. You can tell them where they are in the line.")}</i>
            <u>{t("Best when you get more calls than people to answer them.")}</u>
          </span>
        </button>
        <p className="mt-fine">
          {t("The difference in one sentence: with a group the caller either gets answered or moves on; in a line the caller waits.")}
        </p>
        <MakeTeamStyles />
      </Shell>
    );
  }

  const isQueue = kind === "queue";

  return (
    <Shell
      title={t(isQueue ? "New waiting line" : "New ring group")}
      sub={nextNumber ? `Staff will be able to dial ${nextNumber} to reach it.` : undefined}
      onClose={onClose}
      foot={
        <>
          <button className="mt-btn" onClick={() => setKind(null)} disabled={saving}>{t("Back")}</button>
          <button className="mt-btn primary" onClick={save} disabled={!canSave}>
            {t(saving ? "Setting up..." : "Create it")}
          </button>
        </>
      }
    >
      <label className="mt-lbl">{t("What should it be called?")}</label>
      <input className="mt-in" value={name} onChange={(e) => setName(e.target.value)} placeholder={isQueue ? "Support line" : "Sales team"} />
      <p className="mt-hint">{t("Just for you - callers never hear it.")}</p>

      <label className="mt-lbl">{t("Who's in it?")}</label>
      <p className="mt-hint">{t("Tick everyone whose phone should be involved.")}</p>
      <div className="mt-people">
        {people.map((p) => (
          <button key={p.extension} className={"mt-person" + (members.includes(p.extension) ? " on" : "")}
            onClick={() => toggleMember(p.extension)}>
            <b>{p.name || `Extension ${p.extension}`}</b>
            <span>{p.extension}</span>
          </button>
        ))}
        {people.length === 0 && <p className="mt-hint">{t("No extensions set up yet.")}</p>}
      </div>

      {members.length > 1 && (
        <>
          <label className="mt-lbl">{t(isQueue ? "Order they're offered calls" : "Ring order")}</label>
          <p className="mt-hint">
            {t(isQueue
              ? "Drag to reorder. The person at the top is offered a waiting caller first."
              : strategy === "one_by_one"
                ? "Drag to reorder. Phones ring one at a time, from the top down."
                : "All these phones ring together, so the order doesn't matter unless you switch to one at a time below.")}
          </p>
          <div className="mt-order">
            {members.map((ext, i) => (
              <div
                key={ext}
                className={"mt-orow" + (drag === i ? " dragging" : "")}
                draggable
                onDragStart={() => setDrag(i)}
                onDragOver={(e) => { e.preventDefault(); if (drag !== null && drag !== i) { move(drag, i); setDrag(i); } }}
                onDragEnd={() => setDrag(null)}
              >
                <span className="mt-grip" aria-hidden>⠿</span>
                <span className="mt-onum">{i + 1}</span>
                <span className="mt-oname">{nameFor(ext)}</span>
                <span className="mt-oext">{ext}</span>
                {/* Keyboard and touch users can't drag — arrows do the same job. */}
                <span className="mt-arrows">
                  <button onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up">▲</button>
                  <button onClick={() => move(i, i + 1)} disabled={i === members.length - 1} aria-label="Move down">▼</button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {!isQueue && (
        <>
          <label className="mt-lbl">{t("How should they ring?")}</label>
          <Choice on={strategy === "ringall"} title={t("All at once")}
            desc={t("Every phone rings together. Fastest to answer.")}
            onClick={() => setStrategy("ringall")} />
          <Choice on={strategy === "one_by_one"} title={t("One at a time")}
            desc={t("Rings the first person, then the next, and so on. Use when someone should always get first refusal.")}
            onClick={() => setStrategy("one_by_one")} />
        </>
      )}

      <label className="mt-lbl">{t(isQueue ? "How long each person's phone rings" : "How long to keep ringing")}</label>
      <div className="mt-secs">
        {(isQueue ? [10, 15, 20, 30] : [15, 20, 30, 45]).map((n) => (
          <button key={n} className={"mt-sec" + (ringTime === n ? " on" : "")} onClick={() => setRingTime(n)}>{n}s</button>
        ))}
      </div>
      <p className="mt-hint">
        {t(isQueue
          ? "If they don't pick up in this time, the call is offered to the next person."
          : "After this, the caller goes wherever you choose below. Around 20 seconds is four or five rings.")}
      </p>

      <label className="mt-lbl">{t("If nobody answers, then what?")}</label>
      <Choice on={lastDest?.kind === "voicemail"} title={t("Take a message")}
        desc={t("The caller reaches voicemail and can leave a message.")}
        onClick={() => setLastDest({ kind: "voicemail", target: members[0] ?? people[0]?.extension ?? "" })} />
      <Choice on={lastDest?.kind === "extension"} title={t("Ring one more person")}
        desc={t("Try someone else - an owner or a mobile - before giving up.")}
        onClick={() => setLastDest({ kind: "extension", target: people[0]?.extension ?? "" })} />
      {lastDest && (
        <select className="mt-in" value={lastDest.target} onChange={(e) => setLastDest({ ...lastDest, target: e.target.value })}>
          <option value="">{t("Choose...")}</option>
          {people.map((p) => (
            <option key={p.extension} value={p.extension}>{p.name || `Extension ${p.extension}`} · {p.extension}</option>
          ))}
        </select>
      )}

      {isQueue && (
        <>
          <label className="mt-lbl">{t("While they wait")}</label>
          <Toggle on={announcePosition} onClick={() => setAnnouncePosition(!announcePosition)}
            title={t("Tell them their place in the line")}
            desc={t("“You are third in line.” People wait longer when they know where they are.")} />

          <label className="mt-lbl">{t("Say something every so often")}</label>
          <p className="mt-hint">{t("A short message on repeat - “Thanks for holding, we'll be with you shortly.”")}</p>
          <div className="mt-secs">
            {[0, 30, 45, 60, 90].map((n) => (
              <button key={n} className={"mt-sec" + (periodicSeconds === n ? " on" : "")} onClick={() => setPeriodicSeconds(n)}>
                {n === 0 ? t("Never") : `${n}s`}
              </button>
            ))}
          </div>
          {periodicSeconds > 0 && (
            <>
              <Choice on={overMusic} title={t("Play it over the music")}
                desc={t("The music keeps going underneath. Sounds more natural.")}
                onClick={() => setOverMusic(true)} />
              <Choice on={!overMusic} title={t("Stop the music while it plays")}
                desc={t("The message gets the caller's full attention. Use for something important.")}
                onClick={() => setOverMusic(false)} />
            </>
          )}
        </>
      )}

      <button className="mt-adv" onClick={() => setAdvanced(!advanced)}>
        {advanced ? "▾" : "▸"} {t("More options")}
      </button>
      {advanced && (
        <div className="mt-advbox">
          <label className="mt-lbl">{t("Show something on the phone screen")}</label>
          <input className="mt-in" value={prefix} onChange={(e) => setPrefix(e.target.value)}
            placeholder={name || "Sales"} maxLength={20} />
          <p className="mt-hint">
            {t("Put in front of the caller's name on your handset, so you can tell which line rang before you pick up. Left blank, the team's name is used.")}
          </p>

          {isQueue && (
            <>
              <label className="mt-lbl">{t("Gap before trying again")}</label>
              <div className="mt-secs">
                {[0, 5, 10, 15].map((n) => (
                  <button key={n} className={"mt-sec" + (retry === n ? " on" : "")} onClick={() => setRetry(n)}>
                    {n === 0 ? t("None") : `${n}s`}
                  </button>
                ))}
              </div>
              <p className="mt-hint">{t("A breather after a full round, so phones aren't ringing non-stop.")}</p>

              <label className="mt-lbl">{t("Most callers allowed to wait")}</label>
              <input className="mt-in" type="number" min={0} max={999} value={maxCallers}
                onChange={(e) => setMaxCallers(Math.max(0, Number(e.target.value) || 0))} />
              <p className="mt-hint">
                {t("0 means no limit. Above this, extra callers are sent on rather than joining a line they'll never get through.")}
              </p>

              <label className="mt-lbl">{t("Longest anyone should wait")}</label>
              <input className="mt-in" type="number" min={0} max={7200} value={maxWait}
                onChange={(e) => setMaxWait(Math.max(0, Number(e.target.value) || 0))} />
              <p className="mt-hint">
                {t("In seconds. 0 means no limit. After this the caller stops waiting and goes wherever you chose above.")}
              </p>
            </>
          )}
        </div>
      )}

      {numberWhy && <p className="mt-fine">{numberWhy}</p>}
      {err && <div className="mt-err">{err}</div>}
      <p className="mt-fine">
        {t("This is set up on your phone system straight away, and starts taking calls the next time changes are applied.")}
      </p>
      <MakeTeamStyles />
    </Shell>
  );
}

function Shell({ title, sub, children, foot, onClose }: {
  title: string; sub?: string; children: React.ReactNode; foot?: React.ReactNode; onClose: () => void;
}) {
  return (
    <div className="mt-backdrop" onClick={onClose}>
      <div className="mt-card" onClick={(e) => e.stopPropagation()}>
        <div className="mt-head">
          <div>
            <h3>{title}</h3>
            {sub && <p>{sub}</p>}
          </div>
          <button className="mt-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="mt-body">{children}</div>
        {foot && <div className="mt-foot">{foot}</div>}
      </div>
    </div>
  );
}

function Choice({ on, title, desc, onClick }: { on: boolean; title: string; desc: string; onClick: () => void }) {
  return (
    <button className={"mt-choice" + (on ? " on" : "")} onClick={onClick} type="button">
      <b>{title}</b><span>{desc}</span>
    </button>
  );
}

function Toggle({ on, title, desc, onClick }: { on: boolean; title: string; desc: string; onClick: () => void }) {
  return (
    <button className={"mt-choice mt-toggle" + (on ? " on" : "")} onClick={onClick} type="button">
      <span className="mt-check" aria-hidden>{on ? "✓" : ""}</span>
      <span><b>{title}</b><span>{desc}</span></span>
    </button>
  );
}

function MakeTeamStyles() {
  return (
    <style jsx global>{`
      .mt-backdrop{position:fixed;inset:0;background:rgba(6,12,20,.55);display:grid;place-items:center;padding:20px;z-index:95}
      .mt-card{background:var(--panel,#fff);border:1px solid var(--line,rgba(19,32,48,.13));border-radius:18px;
        width:min(580px,100%);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;
        box-shadow:0 30px 70px -30px rgba(0,0,0,.45);color:inherit}
      .mt-head{display:flex;justify-content:space-between;gap:12px;padding:22px 24px 0}
      .mt-head h3{font-size:19px;font-weight:700;margin:0;letter-spacing:-.015em}
      .mt-head p{margin:6px 0 0;font-size:13.5px;color:var(--dim,#5d6f84);line-height:1.55}
      .mt-x{background:none;border:none;font-size:26px;line-height:1;color:var(--faint,#94a3b8);cursor:pointer;padding:0 4px}
      .mt-body{padding:18px 24px 6px;overflow:auto}
      .mt-lbl{display:block;font-size:12px;font-weight:660;color:var(--dim,#5d6f84);margin:20px 0 7px}
      .mt-body > .mt-lbl:first-child{margin-top:0}
      .mt-hint{font-size:12px;color:var(--faint,#94a3b8);line-height:1.55;margin:6px 0 9px}
      .mt-fine{font-size:11.5px;color:var(--faint,#94a3b8);line-height:1.55;margin:14px 0 0}
      .mt-in{width:100%;font:inherit;font-size:14px;padding:11px 12px;border-radius:11px;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);color:inherit}
      .mt-in:focus{outline:none;border-color:var(--accent,#2f6bff)}
      .mt-pick{display:flex;gap:14px;width:100%;text-align:left;font:inherit;color:inherit;padding:16px;margin-bottom:10px;
        border-radius:14px;cursor:pointer;border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc)}
      .mt-pick:hover{border-color:var(--accent,#2f6bff)}
      .mt-pick-glyph{font-size:26px;flex:none}
      .mt-pick b{display:block;font-size:15.5px;font-weight:670}
      .mt-pick i{display:block;font-style:normal;font-size:13px;color:var(--dim,#5d6f84);margin-top:4px;line-height:1.6}
      .mt-pick u{display:block;text-decoration:none;font-size:12px;color:var(--accent,#2f6bff);margin-top:7px;font-weight:600}
      .mt-choice{display:block;width:100%;text-align:left;font:inherit;color:inherit;padding:13px 14px;margin-bottom:8px;
        border-radius:12px;cursor:pointer;border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc)}
      .mt-choice:hover{border-color:var(--accent,#2f6bff)}
      .mt-choice.on{border-color:var(--accent,#2f6bff);background:var(--accent-soft,rgba(47,107,255,.08))}
      .mt-choice b{display:block;font-size:14px;font-weight:650}
      .mt-choice span{display:block;font-size:12.5px;color:var(--dim,#5d6f84);margin-top:3px;line-height:1.55}
      .mt-toggle{display:flex;gap:12px;align-items:flex-start}
      .mt-check{flex:none;width:20px;height:20px;border-radius:6px;display:grid;place-items:center;font-size:12px;
        border:1px solid var(--line,rgba(19,32,48,.2));background:var(--panel,#fff);color:#fff;margin-top:1px}
      .mt-toggle.on .mt-check{background:var(--accent,#2f6bff);border-color:var(--accent,#2f6bff)}
      .mt-people{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
      .mt-person{text-align:left;font:inherit;color:inherit;padding:10px 12px;border-radius:11px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc)}
      .mt-person.on{border-color:var(--accent,#2f6bff);background:var(--accent-soft,rgba(47,107,255,.08))}
      .mt-person b{display:block;font-size:13.5px;font-weight:640}
      .mt-person span{display:block;font-size:11.5px;color:var(--faint,#94a3b8);margin-top:1px}
      .mt-order{display:flex;flex-direction:column;gap:6px}
      .mt-orow{display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:11px;cursor:grab;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);font-size:13.5px}
      .mt-orow.dragging{opacity:.45}
      .mt-grip{color:var(--faint,#94a3b8);cursor:grab}
      .mt-onum{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;
        background:var(--accent,#2f6bff);color:#fff;flex:none}
      .mt-oname{flex:1;font-weight:600}
      .mt-oext{color:var(--faint,#94a3b8);font-size:12px}
      .mt-arrows{display:flex;flex-direction:column;gap:1px}
      .mt-arrows button{background:none;border:none;font-size:9px;line-height:1.1;color:var(--faint,#94a3b8);cursor:pointer;padding:1px 3px}
      .mt-arrows button:disabled{opacity:.25;cursor:not-allowed}
      .mt-secs{display:flex;gap:7px;flex-wrap:wrap}
      .mt-sec{font:inherit;font-size:13px;font-weight:620;padding:8px 15px;border-radius:10px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc);color:inherit}
      .mt-sec.on{border-color:var(--accent,#2f6bff);background:var(--accent-soft,rgba(47,107,255,.08));color:var(--accent,#2f6bff)}
      .mt-adv{margin-top:20px;background:none;border:none;font:inherit;font-size:13px;font-weight:620;
        color:var(--dim,#5d6f84);cursor:pointer;padding:0}
      .mt-advbox{margin-top:10px;padding:14px 16px;border-radius:12px;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel-2,#f6f9fc)}
      .mt-advbox .mt-lbl:first-child{margin-top:0}
      .mt-err{margin-top:14px;padding:11px 13px;border-radius:11px;font-size:13px;line-height:1.55;
        color:#c9414c;background:rgba(201,65,76,.08);border:1px solid rgba(201,65,76,.28)}
      .mt-foot{display:flex;gap:10px;justify-content:flex-end;padding:16px 24px 20px;
        border-top:1px solid var(--line-soft,rgba(19,32,48,.07))}
      .mt-btn{font:inherit;font-size:14px;font-weight:650;padding:11px 20px;border-radius:11px;cursor:pointer;
        border:1px solid var(--line,rgba(19,32,48,.13));background:var(--panel,#fff);color:inherit}
      .mt-btn.primary{background:var(--accent,#2f6bff);border-color:var(--accent,#2f6bff);color:#fff}
      .mt-btn:disabled{opacity:.5;cursor:not-allowed}
    `}</style>
  );
}
