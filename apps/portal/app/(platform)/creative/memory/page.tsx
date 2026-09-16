"use client";
/**
 * Creative Studio — what the studio has learned.
 *
 * Every item shows its working: how many times it saw the same thing, and the
 * most recent evidence. Anything can be pinned, edited, switched off or thrown
 * away — learned behaviour is data a person controls, never code that changed
 * itself.
 */
import { useCallback, useEffect, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPatch, apiPost, apiDelete } from "../../../../services/apiClient";
import { Card, EmptyState, LoadingCard, Note, PageHead, Pill, errText, fmtWhen } from "../CreativeUi";

const SCOPE_LABEL: Record<string, string> = {
  user: "Yours",
  company: "Company rule",
  workflow: "What works",
  project: "This project",
};

export default function CreativeMemoryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res: any = await apiGet("/creative/memory");
      setItems(res.items || []);
      setErr("");
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = async (id: string, body: any, said: string) => {
    try {
      await apiPatch(`/creative/memory/${id}`, body);
      setNote(said);
      load();
    } catch (e: any) {
      setErr(errText(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await apiDelete(`/creative/memory/${id}`);
      setNote("Removed — it will not be used again.");
      load();
    } catch (e: any) {
      setErr(errText(e));
    }
  };

  const reset = async () => {
    if (!confirm("Clear everything the studio has learned about your work? Your brand kit, projects and files are not touched.")) return;
    try {
      const res: any = await apiPost("/creative/memory/reset", { scopes: ["user"] });
      setNote(`Cleared ${res.removed} learned ${res.removed === 1 ? "preference" : "preferences"}.`);
      load();
    } catch (e: any) {
      setErr(errText(e));
    }
  };

  const active = items.filter((i) => i.status === "active" || i.status === "pinned");
  const suggested = items.filter((i) => i.status === "suggested");
  const off = items.filter((i) => i.status === "disabled");

  const row = (m: any) => (
    <div key={m.id} className="cse-row" style={{ alignItems: "flex-start", border: "1px solid var(--border)", borderRadius: 12, padding: "11px 12px", gap: 10 }}>
      <div style={{ flex: 1 }}>
        <div className="cse-row" style={{ gap: 8 }}>
          <b style={{ fontSize: 13 }}>{m.statement}</b>
          <Pill kind={m.scope === "company" ? "warn" : "nub"}>{SCOPE_LABEL[m.scope] || m.scope}</Pill>
          {m.status === "pinned" ? <Pill kind="info">Pinned</Pill> : null}
          {m.status === "suggested" ? <Pill kind="warn">Suggested</Pill> : null}
        </div>
        <div className="cse-help" style={{ marginTop: 3 }}>
          Seen {m.evidenceCount} {m.evidenceCount === 1 ? "time" : "times"} · last {fmtWhen(m.lastEvidenceAt)}
          {m.evidence?.length ? ` · most recently: ${m.evidence[0].note}` : ""}
        </div>
      </div>
      <div className="cse-row" style={{ gap: 4 }}>
        {m.status === "suggested" ? (
          <>
            <button type="button" className="cse-btn sm primary" onClick={() => update(m.id, { status: "active" }, "Kept — it will use this from now on.")}>
              Keep
            </button>
            <button type="button" className="cse-btn sm" onClick={() => update(m.id, { status: "disabled" }, "Ignored.")}>
              No
            </button>
          </>
        ) : (
          <>
            <button type="button" className="cse-btn sm ghost" onClick={() => update(m.id, { status: m.status === "pinned" ? "active" : "pinned" }, m.status === "pinned" ? "Unpinned." : "Pinned — newer habits will not replace it.")}>
              {m.status === "pinned" ? "Unpin" : "Pin"}
            </button>
            <button type="button" className="cse-btn sm ghost" onClick={() => update(m.id, { status: "disabled" }, "Switched off.")}>
              Turn off
            </button>
            <button type="button" className="cse-btn sm ghost danger" onClick={() => remove(m.id)}>
              Remove
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <PermissionGate permission="can_view_creative_memory" fallback={<div className="cse"><EmptyState title="Creative memory isn't on for your account" text="An admin at your company can switch it on." /></div>}>
      <div className="cse">
        <PageHead
          title="What the studio has learned"
          crumb={["Creative Studio", "Creative memory"]}
          subtitle="Every time you accept, reject, re-do or hand-edit something, it notices. You can read all of it, change it, pin it, or throw it away."
          actions={<button type="button" className="cse-btn" onClick={reset}>Start over</button>}
        />

        {err ? <Note kind="bad">{err}</Note> : null}
        {note ? <Note kind="ok">{note}</Note> : null}

        {loading ? (
          <LoadingCard rows={3} />
        ) : (
          <div className="cse-grid g2" style={{ alignItems: "start" }}>
            <div className="cse-stack">
              <Card title="Being used" sub="Applied to everything it makes for you" end={<Pill kind="ok">{active.length}</Pill>}>
                {active.length ? <div className="cse-stack" style={{ gap: 8 }}>{active.map(row)}</div> : (
                  <EmptyState title="Nothing learned yet" text="Make something and tell it what you think — after the third consistent signal it starts applying what it has noticed." />
                )}
              </Card>

              {suggested.length ? (
                <Card title="Noticed, not applied yet" sub="Waiting for you, or for more evidence" end={<Pill kind="warn">{suggested.length}</Pill>}>
                  <div className="cse-stack" style={{ gap: 8 }}>{suggested.map(row)}</div>
                </Card>
              ) : null}

              {off.length ? (
                <Card title="Switched off" end={<Pill kind="nub">{off.length}</Pill>}>
                  <div className="cse-stack" style={{ gap: 8 }}>{off.map(row)}</div>
                </Card>
              ) : null}
            </div>

            <div className="cse-stack">
              <Card title="How it learns" sub="Deliberately slow and visible">
                <ol style={{ fontSize: 13, paddingLeft: 18, display: "grid", gap: 7, margin: 0 }}>
                  <li>Every accept, reject, re-do and hand-edit is recorded.</li>
                  <li>A preference has to happen <b>three times</b> before it is applied — one bad day does not retrain it.</li>
                  <li>Anything that would apply to your whole company waits for an admin to agree.</li>
                  <li>Every item keeps its evidence, so it can always answer “why do you think that?”.</li>
                  <li>Nothing here changes code. It is data you can edit, pin, switch off or clear.</li>
                </ol>
              </Card>

              <Card title="Where memory lives" sub="Kept apart on purpose">
                <div className="cse-stack" style={{ gap: 8 }}>
                  {[
                    ["Yours", "Just you. Other people at your company have their own."],
                    ["Company rules", "Brand rules everyone here gets. Needs an admin."],
                    ["What works", "Which way of making a thing turned out best."],
                    ["Engine scorecard", "Platform-wide: only how fast and how reliable an engine was — never your prompts or pictures."],
                  ].map(([t, d]) => (
                    <div key={t} className="cse-row" style={{ alignItems: "flex-start" }}>
                      <div style={{ flex: 1 }}>
                        <b style={{ fontSize: 12.5 }}>{t}</b>
                        <div className="cse-help">{d}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <Note kind="warn">
                  <div>The engine scorecard is the only thing shared beyond your company, and it carries no content of yours.</div>
                </Note>
              </Card>
            </div>
          </div>
        )}
      </div>
    </PermissionGate>
  );
}
