"use client";
/**
 * Creative Studio — the video editor.
 *
 * The finished film: shots, graphics, captions, voiceover, music and effects on
 * one timeline, exactly as the approved mockup has it. ⛔ The Coworker uses
 * THESE controls — the same document, the same operations — when you ask it to
 * change something, which is why there is no separate "agent timeline".
 *
 * Everything on screen is something the renderer can really do
 * (`runTimelineRenderJob`): order, trim, split, lay sound under, duck music,
 * burn captions. Nothing is drawn that FFmpeg would then ignore.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { Card, EmptyState, JobProgress, LoadingCard, Note, PageHead, Pill, errText, fmtDuration } from "../CreativeUi";
import { DocObject, newId, useProjectDoc } from "../useProjectDoc";

const TRACKS: Array<{ label: string; type: string; colour: string }> = [
  { label: "Video", type: "clip", colour: "--k-video" },
  { label: "Graphics", type: "gfx", colour: "--k-gfx" },
  { label: "Captions", type: "caption", colour: "--k-cap" },
  { label: "Voiceover", type: "voice", colour: "--k-vo" },
  { label: "Music", type: "music", colour: "--k-music" },
  { label: "Effects", type: "sfx", colour: "--k-sfx" },
];

const seedDoc = () => ({ kind: "timeline", width: 1280, height: 720, fps: 30, burnCaptions: true, objects: [] as DocObject[] });

const ms = (n: any) => Math.max(0, Math.round(Number(n) || 0));
const secs = (n: any) => (ms(n) / 1000).toFixed(1);

export default function CreativeTimelinePage() {
  return (
    <PermissionGate
      permission="can_view_creative_timeline"
      fallback={<div className="cse"><EmptyState title="The video editor isn't on for your account" text="An admin at your company can switch it on." /></div>}
    >
      <div className="cse">
        <TimelineScreen />
      </div>
    </PermissionGate>
  );
}

function TimelineScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params?.get("project") || "";
  const film = useProjectDoc(projectId, "timeline", seedDoc);

  const [sel, setSel] = useState("");
  const [head, setHead] = useState(0); // milliseconds
  const [zoom, setZoom] = useState(64); // pixels per second
  const [err, setErr] = useState("");
  const [job, setJob] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<any>(null);

  const objects = film.objects;
  const assetsById = useMemo(() => {
    const map: Record<string, any> = {};
    for (const a of film.assets) map[a.id] = a;
    return map;
  }, [film.assets]);

  const lengthMs = useMemo(
    () => objects.reduce((n, o) => Math.max(n, ms(o.startMs) + ms(o.durationMs)), 0),
    [objects],
  );
  const totalMs = Math.max(4000, lengthMs);
  const selected = objects.find((o) => o.id === sel) || null;

  /* ---- rendering the cut ------------------------------------------- */

  useEffect(() => () => clearInterval(pollRef.current), []);

  const poll = useCallback((jobId: string) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res: any = await apiGet(`/creative/jobs/${jobId}`);
        setJob(res.job);
        if (["succeeded", "failed", "cancelled"].includes(res.job.status)) {
          clearInterval(pollRef.current);
          if (res.job.status === "succeeded") setResult((res.assets || []).find((a: any) => a.kind === "video") || null);
        }
      } catch {
        /* retried next tick */
      }
    }, 3000);
  }, []);

  const renderCut = async () => {
    setErr("");
    setResult(null);
    setBusy(true);
    try {
      const res: any = await apiPost(`/creative/projects/${projectId}/render`, {});
      setJob(res.job);
      poll(res.job.id);
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      await apiPost(`/creative/jobs/${job.id}/cancel`, {});
    } catch (e: any) {
      setErr(errText(e));
    }
  };

  /* ---- editing ------------------------------------------------------ */

  const set = (id: string, payload: any, summary: string) => film.apply([{ op: "set", target: id, payload, summary }]);

  /** Lay the clips end to end, in the order they are in. */
  const tidy = async () => {
    const clips = objects.filter((o) => o.type === "clip").sort((a, b) => ms(a.startMs) - ms(b.startMs));
    let at = 0;
    const ops = clips.map((c) => {
      const op = { op: "set" as const, target: c.id, payload: { startMs: at }, summary: "Gaps closed" };
      at += ms(c.durationMs);
      return op;
    });
    if (ops.length) await film.apply(ops);
  };

  /**
   * Cut the selected clip at the playhead. The second half carries an in-point,
   * so it really starts where the cut was — the renderer trims from there.
   */
  const split = async () => {
    const c = selected;
    if (!c || c.type !== "clip") return setErr("Pick a clip on the video track first.");
    const start = ms(c.startMs);
    const dur = ms(c.durationMs);
    const at = head - start;
    if (at < 400 || at > dur - 400) return setErr("Move the playhead into the middle of the clip — a piece has to be at least 0.4 seconds.");
    await film.apply([
      { op: "set", target: c.id, payload: { durationMs: at }, summary: "Clip split" },
      {
        op: "add",
        payload: { id: newId("c"), type: "clip", track: 0, assetId: c.assetId, startMs: start + at, durationMs: dur - at, inMs: ms(c.inMs) + at, name: `${c.name || "Shot"} (2)` },
        summary: "Second half of the split",
      },
    ]);
    setErr("");
  };

  const removeSelected = async () => {
    if (!selected) return;
    await film.apply([{ op: "delete", target: selected.id, summary: "Removed from the timeline" }]);
    setSel("");
  };

  /* ---- screens ------------------------------------------------------ */

  if (!projectId) return <NoProject projects={film.projects} loading={film.loading} onPicked={(id) => router.push(`/creative/timeline?project=${id}`)} />;
  if (film.loading) return <LoadingCard rows={5} />;
  if (!film.project) return <Note kind="bad">{film.error || "That project is not there."}</Note>;

  const width = Math.max(240, (totalMs / 1000) * zoom);
  const preview = result || (objects.find((o) => o.type === "clip" && o.assetId) ? assetsById[String(objects.find((o) => o.type === "clip" && o.assetId)!.assetId)] : null);

  return (
    <>
      <PageHead
        crumb={["Creative Studio", film.project.title, "Editor"]}
        title="Video editor"
        subtitle="The finished film on one timeline. The Coworker uses exactly these controls when you ask it to change something."
        actions={
          <>
            <Link className="cse-btn" href={`/creative/storyboard?project=${encodeURIComponent(projectId)}`}>Storyboard</Link>
            <button type="button" className="cse-btn primary" onClick={renderCut} disabled={busy || !objects.some((o) => o.type === "clip")}>
              {busy ? "Starting…" : "Render the cut"}
            </button>
          </>
        }
      />

      {film.overtaken ? <Note kind="warn">Somebody — or the Coworker — changed this film while you had it open. You are looking at their version now.</Note> : null}
      {err ? <Note kind="bad">{err}</Note> : null}
      {film.error ? <Note kind="bad">{film.error}</Note> : null}

      <div className="cse-grid g2" style={{ alignItems: "start", marginBottom: 14 }}>
        <div>
          <div className="cse-thumb">
            {preview ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={preview.url} poster={preview.thumbUrl || undefined} controls preload="metadata" playsInline />
            ) : (
              <EmptyState title="Nothing to show yet" text="Render a shot in the storyboard and it lands here." />
            )}
          </div>
          <div className="cse-row" style={{ flexWrap: "wrap", marginTop: 10 }}>
            <Pill kind="nub">{fmtDuration(totalMs)} · {film.doc?.doc?.width || 1280}×{film.doc?.doc?.height || 720}</Pill>
            <Pill kind="nub">Playhead {secs(head)}s</Pill>
            {result ? (
              <Link className="cse-btn sm" style={{ marginLeft: "auto" }} href={`/creative/export?project=${encodeURIComponent(projectId)}&asset=${result.id}`}>
                Export it
              </Link>
            ) : null}
          </div>
          {job ? (
            <Card className="cse-card" title={job.status === "succeeded" ? "The cut is ready" : "Rendering the cut"}>
              <JobProgress job={job} onCancel={cancel} />
              {result ? <Note kind="ok">Joined, sound laid under, captions burned in. It is in your assets.</Note> : null}
            </Card>
          ) : null}
        </div>

        <Card title={selected ? String(selected.name || TRACKS[Number(selected.track) || 0]?.label || "Selected") : "Nothing selected"} sub={selected ? TRACKS[Number(selected.track) || 0]?.label : "Click a piece on the timeline"}>
          {selected ? (
            <Inspector
              object={selected}
              asset={selected.assetId ? assetsById[String(selected.assetId)] : null}
              onSet={(payload, summary) => set(selected.id, payload, summary)}
              onDelete={removeSelected}
            />
          ) : (
            <p className="cse-help">Everything here is something the renderer really does: order, trim, split, sound under the picture, music ducked under the voice, captions burned in with a .srt beside the file.</p>
          )}
        </Card>
      </div>

      <div className="cse-tlwrap">
        <div className="cse-row" style={{ flexWrap: "wrap", marginBottom: 8 }}>
          <button type="button" className="cse-btn sm" onClick={split}>Split at playhead</button>
          <button type="button" className="cse-btn sm" onClick={tidy}>Close the gaps</button>
          <button type="button" className="cse-btn sm" onClick={removeSelected} disabled={!selected}>Remove</button>
          <label className="cse-row" style={{ marginLeft: "auto", gap: 6 }}>
            <span className="cse-help">Zoom</span>
            <input className="cse-range" type="range" min={24} max={160} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ width: 110 }} />
          </label>
        </div>

        <div className="cse-tlscroll">
          <div className="cse-tlinner" style={{ minWidth: width + 110 }}>
            <div
              className="cse-ruler"
              style={{ width }}
              role="slider"
              tabIndex={0}
              aria-label="Playhead"
              aria-valuenow={Math.round(head / 1000)}
              aria-valuemin={0}
              aria-valuemax={Math.round(totalMs / 1000)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setHead((h) => Math.max(0, h - 200));
                if (e.key === "ArrowRight") setHead((h) => Math.min(totalMs, h + 200));
              }}
              onClick={(e) => {
                const box = (e.target as HTMLElement).closest(".cse-ruler")!.getBoundingClientRect();
                setHead(Math.max(0, Math.min(totalMs, Math.round(((e.clientX - box.left) / zoom) * 1000))));
              }}
            >
              {Array.from({ length: Math.floor(totalMs / 1000) + 1 }, (_, i) => (
                <i key={i} style={{ left: i * zoom }}>{i}s</i>
              ))}
            </div>

            {TRACKS.map((track, ti) => (
              <div className="cse-track" key={track.type}>
                <span className="tname">{track.label}</span>
                <div className="cse-lanebox" style={{ width }}>
                  {objects
                    .filter((o) => (Number(o.track) || 0) === ti)
                    .map((o) => (
                      <button
                        type="button"
                        key={o.id}
                        className={`cse-clip ${o.id === sel ? "on" : ""}`}
                        style={{ left: (ms(o.startMs) / 1000) * zoom, width: Math.max(18, (ms(o.durationMs) / 1000) * zoom - 3), background: `var(${track.colour})` }}
                        onClick={() => setSel(o.id)}
                      >
                        {String(o.name || o.text || track.label)}
                      </button>
                    ))}
                </div>
              </div>
            ))}
            <div className="cse-playhead" style={{ left: 104 + (head / 1000) * zoom }} />
          </div>
        </div>
      </div>

      <Card title="What goes out" sub="Sound and captions are added by the render, not by a second tool">
        <div className="cse-row" style={{ flexWrap: "wrap" }}>
          <label className="cse-row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={film.doc?.doc?.burnCaptions !== false}
              onChange={(e) => film.setDocFields({ burnCaptions: e.target.checked })}
            />
            <span>Burn the captions into the picture</span>
          </label>
          <span className="cse-help">A .srt file is saved beside the film either way, for the places that want one.</span>
          <Link className="cse-btn sm" style={{ marginLeft: "auto" }} href={`/creative/audio?project=${encodeURIComponent(projectId)}`}>Voice, music &amp; captions</Link>
        </div>
      </Card>
    </>
  );
}

/** The one piece you clicked, and only the controls that really apply to it. */
function Inspector({ object, asset, onSet, onDelete }: { object: DocObject; asset: any; onSet: (payload: any, summary: string) => void; onDelete: () => void }) {
  const isAudio = ["voice", "music", "sfx"].includes(String(object.type));
  const isCaption = object.type === "caption";
  return (
    <div className="cse-stack">
      <div className="cse-grid g2" style={{ gap: 10 }}>
        <label className="cse-fld">
          Starts at
          <input
            className="cse-input cse-num"
            type="number"
            step="0.1"
            min="0"
            defaultValue={secs(object.startMs)}
            onBlur={(e) => onSet({ startMs: Math.round(Number(e.target.value || 0) * 1000) }, "Moved")}
          />
        </label>
        <label className="cse-fld">
          Length
          <input
            className="cse-input cse-num"
            type="number"
            step="0.1"
            min="0.1"
            defaultValue={secs(object.durationMs)}
            onBlur={(e) => onSet({ durationMs: Math.max(100, Math.round(Number(e.target.value || 0) * 1000)) }, "Length changed")}
          />
        </label>
      </div>

      {asset ? (
        <p className="cse-help">
          {asset.name} · {fmtDuration(asset.durationMs)} of source{ms(object.inMs) ? `, starting ${secs(object.inMs)}s in` : ""}
        </p>
      ) : null}

      {isCaption ? (
        <label className="cse-fld">
          What it says
          <textarea
            className="cse-input"
            rows={2}
            defaultValue={String(object.text || "")}
            onBlur={(e) => onSet({ text: e.target.value.slice(0, 300) }, "Caption changed")}
          />
        </label>
      ) : null}

      {isAudio ? (
        <>
          <label className="cse-fld">
            Volume
            <input
              className="cse-range"
              type="range"
              min={0}
              max={100}
              defaultValue={Math.round(Number(object.gain ?? (object.type === "music" ? 0.18 : 0.9)) * 100)}
              onMouseUp={(e) => onSet({ gain: Number((e.target as HTMLInputElement).value) / 100 }, "Volume changed")}
              onTouchEnd={(e) => onSet({ gain: Number((e.target as HTMLInputElement).value) / 100 }, "Volume changed")}
            />
          </label>
          {object.type === "music" ? (
            <label className="cse-row" style={{ gap: 8 }}>
              <input type="checkbox" checked={object.duck !== false} onChange={(e) => onSet({ duck: e.target.checked }, "Ducking changed")} />
              <span>
                Drop under the voice
                <span className="cse-help" style={{ display: "block" }}>Music sits quietly while anyone is speaking.</span>
              </span>
            </label>
          ) : null}
        </>
      ) : null}

      <div className="cse-row">
        <button type="button" className="cse-btn sm" onClick={onDelete} style={{ marginLeft: "auto" }}>Remove from the film</button>
      </div>
    </div>
  );
}

function NoProject({ projects, loading, onPicked }: { projects: any[]; loading: boolean; onPicked: (id: string) => void }) {
  return (
    <>
      <PageHead crumb={["Creative Studio", "Video editor"]} title="Video editor" subtitle="A cut belongs to a project. Pick the film you are working on." />
      {loading ? <LoadingCard /> : projects.length ? (
        <Card title="Your projects">
          <div className="cse-stack">
            {projects.map((p) => (
              <div className="cse-row" key={p.id}>
                <b style={{ fontSize: 13 }}>{p.title}</b>
                <span className="cse-muted" style={{ fontSize: 12 }}>{p.kind}</span>
                <button type="button" className="cse-btn sm" style={{ marginLeft: "auto" }} onClick={() => onPicked(p.id)}>Open the editor</button>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState title="No films yet" text="Start one in the storyboard — three empty shots and a description each is all it takes." action={<Link className="cse-btn primary" href="/creative/storyboard">Open the storyboard</Link>} />
      )}
    </>
  );
}
