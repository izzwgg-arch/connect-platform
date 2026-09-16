"use client";
/**
 * Creative Studio — one project.
 *
 * Brief, what was made, the jobs, the versions and the generation records —
 * enough that any result can be reproduced or turned into a variation.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../../services/apiClient";
import { AssetThumb, Card, EmptyState, LoadingCard, Note, PageHead, Pill, errText, fmtWhen, money } from "../../CreativeUi";

const TABS = ["Overview", "What was made", "Generations", "Versions"] as const;

export default function CreativeProjectPage() {
  const params = useParams();
  const router = useRouter();
  const id = String((params as any)?.id || "");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res: any = await apiGet(`/creative/projects/${id}`);
      setData(res);
      setErr("");
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) load();
  }, [id, load]);

  const snapshot = async () => {
    try {
      const res: any = await apiPost(`/creative/projects/${id}/versions`, { label: `Saved ${new Date().toLocaleString()}` });
      setNote(`Saved as version ${res.version.number}.`);
      load();
    } catch (e: any) {
      setErr(errText(e));
    }
  };

  if (loading) return <div className="cse"><LoadingCard rows={4} /></div>;
  if (!data) return <div className="cse"><EmptyState title="That project is not here" text="It may have been deleted, or it belongs to another company." /></div>;

  const p = data.project;

  return (
    <PermissionGate permission="can_view_creative_projects" fallback={<div className="cse"><EmptyState title="Projects aren't on for your account" /></div>}>
      <div className="cse">
        <PageHead
          title={p.title}
          crumb={["Creative Studio", "Projects", p.title]}
          subtitle={p.brief || "No brief written yet."}
          actions={
            <>
              <Pill kind="nub">{money(p.spentMicros)} spent</Pill>
              <button type="button" className="cse-btn" onClick={snapshot}>Save a version</button>
              <button type="button" className="cse-btn primary" onClick={() => router.push(`/creative/images?project=${p.id}`)}>Make something</button>
            </>
          }
        />

        {err ? <Note kind="bad">{err}</Note> : null}
        {note ? <Note kind="ok">{note}</Note> : null}

        <div className="cse-chips" style={{ marginBottom: 12 }}>
          {TABS.map((t) => (
            <button key={t} type="button" className={`cse-chip ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {t}
              {t === "What was made" && data.assets?.length ? ` (${data.assets.length})` : ""}
              {t === "Versions" && data.versions?.length ? ` (${data.versions.length})` : ""}
            </button>
          ))}
        </div>

        {tab === "Overview" ? (
          <div className="cse-grid g2">
            <Card title="The brief">
              <p style={{ fontSize: 13.5 }}>{p.brief || "Nothing written down yet."}</p>
              <div className="cse-divider" />
              <dl className="cse-stack" style={{ gap: 6, fontSize: 12.5, margin: 0 }}>
                {[["Kind", p.kind], ["Status", p.status], ["Visible to", p.visibility === "company" ? "everyone at this company" : "just you"], ["Spent", money(p.spentMicros)], ["Started", fmtWhen(p.createdAt)]].map(([k, v]) => (
                  <div key={String(k)} className="cse-row"><span className="cse-muted">{k}</span><span style={{ marginLeft: "auto" }}>{v}</span></div>
                ))}
              </dl>
            </Card>
            <Card title="Work in flight" sub="Jobs for this project">
              {data.jobs?.length ? (
                <div className="cse-stack" style={{ gap: 7 }}>
                  {data.jobs.map((j: any) => (
                    <div key={j.id} className="cse-row">
                      <Pill kind={j.status === "succeeded" ? "ok" : j.status === "failed" ? "bad" : "info"}>{j.status}</Pill>
                      <span style={{ fontSize: 12.5, flex: 1 }}>{j.capability}</span>
                      <span className="cse-help">{money(j.costMicros)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="Nothing made yet" text="Make an image or a video and it will be kept here." />
              )}
            </Card>
          </div>
        ) : tab === "What was made" ? (
          data.assets?.length ? (
            <div className="cse-resgrid">
              {data.assets.map((a: any) => (
                <div key={a.id} className="cse-res">
                  <AssetThumb asset={a} />
                  <div style={{ padding: "8px 9px" }}>
                    <b style={{ fontSize: 12.5 }}>{a.name}</b>
                    <div className="cse-help">{a.kind} · {fmtWhen(a.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="Nothing here yet" />
          )
        ) : tab === "Generations" ? (
          <Card title="Every generation" sub="Kept so any result can be made again or turned into a variation">
            <div className="cse-twrap">
              <table className="cse-t">
                <thead><tr><th>What was asked</th><th>Engine</th><th>Seed</th><th className="r">Took</th><th className="r">Cost</th><th>Outcome</th></tr></thead>
                <tbody>
                  {(data.generations || []).map((g: any) => (
                    <tr key={g.id}>
                      <td>{g.request?.slice(0, 70) || "—"}</td>
                      <td className="cse-muted">{g.engineId}</td>
                      <td className="cse-mono">{g.seed || "—"}</td>
                      <td className="r cse-muted">{g.renderMs ? `${Math.round(g.renderMs / 100) / 10}s` : "—"}</td>
                      <td className="r">{money(g.costMicros)}</td>
                      <td>{g.outcome ? <Pill kind={g.outcome === "kept" ? "ok" : "bad"}>{g.outcome}</Pill> : <span className="cse-help">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!(data.generations || []).length ? <EmptyState title="No generations yet" /> : null}
          </Card>
        ) : (
          <Card title="Versions" sub="Every saved point, whoever made it">
            {data.versions?.length ? (
              <div className="cse-stack" style={{ gap: 8 }}>
                {data.versions.map((v: any) => (
                  <div key={v.id} className="cse-row" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "9px 11px" }}>
                    <Pill kind={v.actorType === "coworker" ? "info" : "nub"}>{v.actorType === "coworker" ? "Coworker" : "Person"}</Pill>
                    <div style={{ flex: 1 }}>
                      <b style={{ fontSize: 12.5 }}>v{v.number} · {v.label}</b>
                      <div className="cse-help">{v.summary || "No note"} · {fmtWhen(v.createdAt)}</div>
                    </div>
                    <button
                      type="button"
                      className="cse-btn sm"
                      onClick={async () => {
                        if (!confirm(`Go back to v${v.number}? The current state is kept as a new version first.`)) return;
                        try {
                          await apiPost(`/creative/projects/${id}/versions`, { label: "Before restore" });
                          await apiPost(`/creative/projects/${id}/versions/${v.id}/restore`, {});
                          setNote(`Restored v${v.number}.`);
                          load();
                        } catch (e: any) {
                          setErr(errText(e));
                        }
                      }}
                    >
                      Go back to this
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="No versions saved yet" text="Press “Save a version” to keep a point you can return to." />
            )}
          </Card>
        )}
      </div>
    </PermissionGate>
  );
}
