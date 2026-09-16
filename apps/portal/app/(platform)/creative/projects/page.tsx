"use client";
/**
 * Creative Studio — projects.
 *
 * A project keeps one piece of work together: the brief, what was made, the
 * designs, the spend. Without the company-projects key you see your own work
 * and anything explicitly shared with the company — enforced on the server.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { Card, EmptyState, LoadingCard, Note, PageHead, Pill, errText, fmtWhen, money } from "../CreativeUi";

const KINDS = ["", "video", "image", "design", "social", "ad", "flyer"];

export default function CreativeProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<any[]>([]);
  const [kind, setKind] = useState("");
  const [mine, setMine] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: "100" });
      if (kind) q.set("kind", kind);
      if (mine) q.set("mine", "1");
      const res: any = await apiGet(`/creative/projects?${q}`);
      setProjects(res.projects || []);
      setErr("");
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [kind, mine]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    const title = prompt("What is this project called?");
    if (!title?.trim()) return;
    setCreating(true);
    try {
      const res: any = await apiPost("/creative/projects", { title: title.trim(), kind: "image" });
      router.push(`/creative/projects/${res.project.id}`);
    } catch (e: any) {
      setErr(errText(e));
      setCreating(false);
    }
  };

  return (
    <PermissionGate permission="can_view_creative_projects" fallback={<div className="cse"><EmptyState title="Projects aren't on for your account" text="An admin at your company can switch them on." /></div>}>
      <div className="cse">
        <PageHead
          title="Projects"
          crumb={["Creative Studio", "Projects"]}
          subtitle="Everything this company has made. Saved automatically, versioned, and visible only to people you allow."
          actions={<button type="button" className="cse-btn primary" disabled={creating} onClick={create}>New project</button>}
        />

        {err ? <Note kind="bad">{err}</Note> : null}

        <div className="cse-row wrap" style={{ marginBottom: 12 }}>
          <div className="cse-chips">
            {KINDS.map((k) => (
              <button key={k || "all"} type="button" className={`cse-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                {k || "All"}
              </button>
            ))}
          </div>
          <button type="button" className={`cse-chip ${mine ? "on" : ""}`} style={{ marginLeft: "auto" }} onClick={() => setMine(!mine)}>
            Only mine
          </button>
        </div>

        {loading ? (
          <LoadingCard rows={4} />
        ) : projects.length ? (
          <Card>
            <div className="cse-twrap">
              <table className="cse-t">
                <thead>
                  <tr><th>Project</th><th>Kind</th><th>Status</th><th className="r">Spent</th><th className="r">Updated</th><th></th></tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id}>
                      <td><b>{p.title}</b>{p.brief ? <div className="cse-help">{p.brief.slice(0, 80)}</div> : null}</td>
                      <td className="cse-muted">{p.kind}</td>
                      <td><Pill kind={p.status === "done" ? "ok" : p.status === "working" ? "info" : "nub"}>{p.status}</Pill></td>
                      <td className="r">{money(p.spentMicros)}</td>
                      <td className="r cse-muted">{fmtWhen(p.updatedAt)}</td>
                      <td className="r"><button type="button" className="cse-btn sm" onClick={() => router.push(`/creative/projects/${p.id}`)}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <EmptyState
            title="No projects yet"
            text="A project keeps a piece of work together — the brief, the shots, the designs and what it cost."
            action={<button type="button" className="cse-btn primary sm" onClick={create}>New project</button>}
          />
        )}
      </div>
    </PermissionGate>
  );
}
