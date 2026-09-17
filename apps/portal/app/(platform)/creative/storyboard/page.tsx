"use client";
/**
 * Creative Studio — the storyboard.
 *
 * One card per shot, exactly as the approved mockup has it. A single generated
 * clip is capped at 15 seconds, so a longer film is simply more shots — and
 * because every shot is its own render, a person can change the one that came
 * out wrong without paying for the other four again.
 *
 * ⛔ Every change goes through the document ops door, so the Coworker rewriting
 * a shot and a person retyping it are the same kind of event, in one history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { Card, EmptyState, LoadingCard, Note, PageHead, Pill, errText, money } from "../CreativeUi";
import { DocObject, newId, useProjectDoc } from "../useProjectDoc";

/** The lengths the studio offers. The engine's own clip limits are its problem. */
const LENGTHS = [4, 5, 6, 8, 10, 12, 15];
const TRANSITIONS = ["Cut", "Dissolve 0.4s", "Fade to black"];
const RATIOS: Array<[string, string]> = [["16:9", "Landscape"], ["9:16", "Upright"], ["1:1", "Square"], ["4:5", "Feed"]];

interface Shot extends DocObject {
  title?: string;
  prompt?: string;
  seconds?: number;
  assetId?: string | null;
  jobId?: string | null;
  transition?: string;
}

function seedDoc() {
  return {
    kind: "storyboard",
    ratio: "16:9",
    objects: [
      { id: newId("s"), type: "shot", title: "Shot 1", prompt: "", seconds: 5, transition: "Cut" },
      { id: newId("s"), type: "shot", title: "Shot 2", prompt: "", seconds: 5, transition: "Cut" },
      { id: newId("s"), type: "shot", title: "Shot 3", prompt: "", seconds: 5, transition: "Cut" },
    ],
  };
}

export default function CreativeStoryboardPage() {
  return (
    <PermissionGate
      permission="can_view_creative_storyboard"
      fallback={<div className="cse"><EmptyState title="Storyboards aren't on for your account" text="An admin at your company can switch them on." /></div>}
    >
      <div className="cse">
        <StoryboardScreen />
      </div>
    </PermissionGate>
  );
}

function StoryboardScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params?.get("project") || "";
  const board = useProjectDoc(projectId, "storyboard", seedDoc);

  const [sel, setSel] = useState<string>("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [jobs, setJobs] = useState<Record<string, any>>({});
  const [assetsById, setAssetsById] = useState<Record<string, any>>({});
  const [newTitle, setNewTitle] = useState("");
  const dragging = useRef<string>("");
  const pollRef = useRef<any>(null);

  const shots = useMemo(() => board.objects.filter((o) => o.type === "shot") as Shot[], [board.objects]);
  const total = shots.reduce((n, s) => n + Number(s.seconds || 0), 0);
  const ratio = String(board.doc?.doc?.ratio || "16:9");

  useEffect(() => {
    const map: Record<string, any> = {};
    for (const a of board.assets) map[a.id] = a;
    setAssetsById((prev) => ({ ...prev, ...map }));
  }, [board.assets]);

  /* ---- the shots that are rendering right now ---------------------- */

  const watch = useCallback(
    (shotId: string, jobId: string) => {
      setJobs((j) => ({ ...j, [shotId]: { id: jobId, status: "queued", progress: 0 } }));
    },
    [],
  );

  useEffect(() => {
    clearInterval(pollRef.current);
    const live = Object.entries(jobs).filter(([, j]) => j && !["succeeded", "failed", "cancelled"].includes(j.status));
    if (!live.length) return;
    pollRef.current = setInterval(async () => {
      for (const [shotId, j] of live) {
        try {
          const res: any = await apiGet(`/creative/jobs/${j.id}`);
          setJobs((prev) => ({ ...prev, [shotId]: res.job }));
          if (res.job.status === "succeeded") {
            const asset = (res.assets || []).find((a: any) => a.kind === "video") || (res.assets || [])[0];
            if (asset) setAssetsById((prev) => ({ ...prev, [asset.id]: asset }));
            // ⛔ The SERVER attached the clip to the shot when the render
            // finished (jobs.ts attachToShot) — the same path the Coworker
            // gets. Writing it again here would be a second implementation and
            // would collide with that one on the revision.
            await board.reload();
          }
          if (res.job.status === "failed") {
            await board.apply([{ op: "set", target: shotId, payload: { jobId: null }, summary: "Render failed" }]);
          }
        } catch {
          /* a poll that fails is retried on the next tick */
        }
      }
    }, 3500);
    return () => clearInterval(pollRef.current);
    // board.apply changes identity with every revision; re-subscribing on that
    // would restart the timer constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  /* ---- editing ----------------------------------------------------- */

  const setShot = async (id: string, payload: any, summary: string) => {
    setErr("");
    await board.apply([{ op: "set", target: id, payload, summary }]);
  };

  const addShot = async () => {
    const id = newId("s");
    await board.apply([
      { op: "add", payload: { id, type: "shot", title: `Shot ${shots.length + 1}`, prompt: "", seconds: 5, transition: "Cut" }, summary: "Shot added" },
    ]);
    setSel(id);
  };

  const removeShot = async (id: string) => {
    await board.apply([{ op: "delete", target: id, summary: "Shot removed" }]);
  };

  const reorder = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const to = board.objects.findIndex((o) => o.id === toId);
    if (to < 0) return;
    await board.apply([{ op: "reorder", target: fromId, payload: { to }, summary: "Shots re-ordered" }]);
  };

  /* ---- rendering --------------------------------------------------- */

  const renderShot = async (shot: Shot) => {
    if (!String(shot.prompt || "").trim()) {
      setErr("Describe the shot first — that is what gets rendered.");
      return;
    }
    setBusy(shot.id);
    setErr("");
    try {
      const res: any = await apiPost("/creative/jobs", {
        capability: "video.generate",
        projectId,
        request: shot.prompt,
        seconds: Math.max(1, Math.min(15, Number(shot.seconds || 5))),
        ratio,
        quality: "low",
        shotId: shot.id,
      });
      watch(shot.id, res.job.id);
      await setShot(shot.id, { jobId: res.job.id }, "Render started");
      if (res.deduped) setNote("That exact shot was already being made — this is the same render, not a second charge.");
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setBusy("");
    }
  };

  const renderAll = async () => {
    const todo = shots.filter((s) => String(s.prompt || "").trim() && !s.assetId);
    if (!todo.length) {
      setErr("Every shot with a description is already rendered.");
      return;
    }
    for (const shot of todo) {
      // One at a time: the company's concurrency allowance refuses the rest
      // with a plain reason, and firing them all would just collect refusals.
      // eslint-disable-next-line no-await-in-loop
      await renderShot(shot);
    }
  };

  /* ---- hand it to the editor --------------------------------------- */

  const openInEditor = async () => {
    const ready = shots.filter((s) => s.assetId);
    if (!ready.length) {
      setErr("Render at least one shot first — the editor cuts what exists.");
      return;
    }
    setBusy("timeline");
    try {
      // ⛔ The server assembles it — the SAME call the Coworker makes. Building
      // the cut here as well would be a second implementation that drifts, and
      // the one nobody tested is the one a customer would get.
      await apiPost(`/creative/projects/${projectId}/assemble`, {});
      router.push(`/creative/timeline?project=${encodeURIComponent(projectId)}`);
    } catch (e: any) {
      setErr(errText(e));
      setBusy("");
    }
  };

  /* ---- screens ----------------------------------------------------- */

  if (!projectId) return <PickProject projects={board.projects} loading={board.loading} onPicked={(id) => router.push(`/creative/storyboard?project=${id}`)} title={newTitle} setTitle={setNewTitle} />;
  if (board.loading) return <LoadingCard rows={4} />;
  if (!board.project) return <Note kind="bad">{board.error || "That project is not there."}</Note>;

  const estimate = total * 100000; // micros, at the draft rate

  return (
    <>
      <PageHead
        crumb={["Creative Studio", board.project.title, "Storyboard"]}
        title="Storyboard"
        subtitle="One card per shot. A single clip is capped at 15 seconds — a longer film is simply more shots, and each one can be redone on its own."
        actions={
          <>
            <Link className="cse-btn" href={`/creative/projects/${projectId}`}>Back to the project</Link>
            <button type="button" className="cse-btn primary" onClick={renderAll} disabled={!!busy}>
              {busy && busy !== "timeline" ? "Starting…" : "Render all"}
            </button>
          </>
        }
      />

      {board.overtaken ? <Note kind="warn">Somebody — or the Coworker — changed this storyboard while you had it open. You are looking at their version now; make your change again.</Note> : null}
      {err ? <Note kind="bad">{err}</Note> : null}
      {note ? <Note kind="info">{note}</Note> : null}
      {board.error ? <Note kind="bad">{board.error}</Note> : null}

      <div className="cse-row" style={{ flexWrap: "wrap", marginBottom: 10 }}>
        <Pill kind="info">{shots.length} shots · {total}s total</Pill>
        <Pill kind="nub">Roughly {money(estimate)} to render what is left</Pill>
        <label className="cse-fld" style={{ marginLeft: "auto", minWidth: 150 }}>
          Shape
          <ConnectSelect
            ariaLabel="Shape"
            value={ratio}
            onChange={(v) => board.setDocFields({ ratio: v })}
            options={RATIOS.map(([v, label]) => ({ value: v, label: `${label} · ${v}` }))}
            placeholder={ratio}
          />
        </label>
      </div>
      <p className="cse-help" style={{ marginBottom: 10 }}>Drag a card by its handle to re-order. Everything saves as you go.</p>

      <div className="cse-shots">
        {shots.map((shot, i) => {
          const job = jobs[shot.id];
          const asset = shot.assetId ? assetsById[String(shot.assetId)] : null;
          const rendering = !!(job && !["succeeded", "failed", "cancelled"].includes(job.status)) || !!shot.jobId;
          return (
            <div key={shot.id} style={{ display: "contents" }}>
              {i ? (
                <div className="cse-transition">
                  <button
                    type="button"
                    onClick={() => setShot(shot.id, { transition: TRANSITIONS[(TRANSITIONS.indexOf(String(shot.transition || "Cut")) + 1) % TRANSITIONS.length] }, "Transition changed")}
                  >
                    {shot.transition || "Cut"}
                  </button>
                  <span className="cse-help">transition</span>
                </div>
              ) : null}
              <div
                className={`cse-shot ${sel === shot.id ? "on" : ""}`}
                onClick={() => setSel(shot.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); reorder(dragging.current, shot.id); dragging.current = ""; }}
              >
                <div
                  className="sh"
                  draggable
                  onDragStart={() => { dragging.current = shot.id; }}
                  onDragEnd={() => { dragging.current = ""; }}
                >
                  <span>{shot.title || `Shot ${i + 1}`}</span>
                  <ConnectSelect
                    ariaLabel="Shot length"
                    size="sm"
                    style={{ marginLeft: "auto", width: 72, minWidth: 72 }}
                    value={String(Number(shot.seconds || 5))}
                    onChange={(v) => setShot(shot.id, { seconds: Number(v) }, "Shot length changed")}
                    options={LENGTHS.map((n) => ({ value: String(n), label: `${n}s` }))}
                    placeholder={`${Number(shot.seconds || 5)}s`}
                    dropdownWidth={96}
                  />
                </div>

                <div className="cse-thumb" style={{ borderRadius: 0 }}>
                  {asset ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video src={asset.url} poster={asset.thumbUrl || undefined} controls preload="metadata" playsInline />
                  ) : (
                    <div className="cse-empty" style={{ border: 0, padding: 14, fontSize: 12 }}>
                      {rendering ? <span className="cse-spin" /> : null}
                      <p style={{ margin: 0 }}>{rendering ? `${job?.note || "Rendering"} ${job?.progress ? `${job.progress}%` : ""}` : "Not rendered yet"}</p>
                    </div>
                  )}
                </div>

                <div className="sb">
                  <textarea
                    className="prompt"
                    placeholder="What happens in this shot? e.g. “a van pulls up outside a shop at dusk, camera slowly pushes in”"
                    defaultValue={String(shot.prompt || "")}
                    onBlur={(e) => { if (e.target.value !== shot.prompt) setShot(shot.id, { prompt: e.target.value.slice(0, 2000) }, "Shot description changed"); }}
                  />
                  {asset ? <Pill kind="ok">Ready</Pill> : rendering ? <Pill kind="warn">Rendering</Pill> : job?.status === "failed" ? <Pill kind="bad">Failed</Pill> : <Pill>Not rendered</Pill>}
                  {job?.status === "failed" ? <span className="cse-help">{job.error}</span> : null}
                </div>

                <div className="acts">
                  <button type="button" className="cse-btn sm" disabled={busy === shot.id || rendering} onClick={() => renderShot(shot)}>
                    {asset ? "Render again" : "Render"}
                  </button>
                  {asset ? (
                    <button type="button" className="cse-btn sm" onClick={() => setShot(shot.id, { assetId: null }, "Clip removed from the shot")}>
                      Unlink
                    </button>
                  ) : null}
                  <button type="button" className="cse-btn sm" onClick={() => removeShot(shot.id)}>Delete</button>
                </div>
              </div>
            </div>
          );
        })}
        <div className="cse-transition">
          <button type="button" onClick={addShot}>+ Add shot</button>
        </div>
      </div>

      <Card title="Everything under the picture" sub="Laid over the whole film, not per shot" className="cse-card" >
        <div className="cse-lanes">
          {[
            ["Voiceover", "--k-vo", "Written and spoken in the voice you pick"],
            ["Music", "--k-music", "Sits under the narration automatically"],
            ["Captions", "--k-cap", "Burned in, and a .srt beside the file"],
          ].map(([name, colour, hint]) => (
            <div className="cse-lane" key={name}>
              <span className="lname">{name}</span>
              <div className="lbar">
                <div className="lseg" style={{ background: `var(${colour})`, width: "100%" }}>{hint}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="cse-row" style={{ flexWrap: "wrap", marginTop: 12 }}>
          <Link className="cse-btn sm" href={`/creative/audio?project=${encodeURIComponent(projectId)}`}>Voice, music &amp; captions</Link>
          <button type="button" className="cse-btn sm primary" onClick={openInEditor} disabled={busy === "timeline"}>
            {busy === "timeline" ? "Opening…" : "Open in the editor"}
          </button>
        </div>
      </Card>
    </>
  );
}

/** No project in the address: pick one, or start one, and stay on this screen. */
function PickProject({ projects, loading, onPicked, title, setTitle }: { projects: any[]; loading: boolean; onPicked: (id: string) => void; title: string; setTitle: (s: string) => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) return setErr("Give it a name first.");
    setBusy(true);
    try {
      const res: any = await apiPost("/creative/projects", { title: title.trim(), kind: "video" });
      onPicked(res.project.id);
    } catch (e: any) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead crumb={["Creative Studio", "Storyboard"]} title="Storyboard" subtitle="A storyboard belongs to a project. Pick the one you are working on, or start a new one." />
      {err ? <Note kind="bad">{err}</Note> : null}
      <Card title="Start a new film">
        <div className="cse-row">
          <input className="cse-input" placeholder="What is it for? e.g. “Autumn phone-system offer”" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="cse-btn primary" onClick={create} disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </Card>
      {loading ? <LoadingCard /> : projects.length ? (
        <Card title="Or carry on with one of these">
          <div className="cse-stack">
            {projects.map((p) => (
              <div className="cse-row" key={p.id}>
                <b style={{ fontSize: 13 }}>{p.title}</b>
                <span className="cse-muted" style={{ fontSize: 12 }}>{p.kind}</span>
                <button type="button" className="cse-btn sm" style={{ marginLeft: "auto" }} onClick={() => onPicked(p.id)}>Open the storyboard</button>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState title="Nothing here yet" text="Name a film above and the storyboard opens with three empty shots." />
      )}
    </>
  );
}
