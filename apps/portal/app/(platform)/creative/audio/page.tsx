"use client";
/**
 * Creative Studio — voice, music and captions.
 *
 * Everything that goes under the picture, on one screen, as the approved
 * mockup has it. Each piece lands on the film's timeline the moment it is
 * made, so there is no "now drag it in" step — and because the timeline is the
 * same document the editor and the Coworker use, it shows up there too.
 *
 * ⛔ Captions are generated from the voiceover script and spread across the
 * spoken audio's REAL duration, not a guess: a caption that drifts out of sync
 * is worse than no caption at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { Card, EmptyState, JobProgress, LoadingCard, Note, PageHead, Pill, errText, fmtDuration } from "../CreativeUi";
import { newId, useProjectDoc } from "../useProjectDoc";
import { captionCues, captionLines } from "../../../../lib/creativeCaptions";

const seedDoc = () => ({ kind: "timeline", width: 1280, height: 720, fps: 30, burnCaptions: true, objects: [] as any[] });
const ms = (n: any) => Math.max(0, Math.round(Number(n) || 0));

export default function CreativeAudioPage() {
  return (
    <PermissionGate
      permission="can_view_creative_audio"
      fallback={<div className="cse"><EmptyState title="Voice and music aren't on for your account" text="An admin at your company can switch them on." /></div>}
    >
      <div className="cse">
        <AudioScreen />
      </div>
    </PermissionGate>
  );
}

function AudioScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params?.get("project") || "";
  const film = useProjectDoc(projectId, "timeline", seedDoc);

  const [script, setScript] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [voices, setVoices] = useState<any[]>([]);
  const [musicBrief, setMusicBrief] = useState("");
  const [musicSeconds, setMusicSeconds] = useState(15);
  const [job, setJob] = useState<any>(null);
  const [what, setWhat] = useState<"voice" | "music" | "">("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<any>(null);

  const assetsById = useMemo(() => {
    const map: Record<string, any> = {};
    for (const a of film.assets) map[a.id] = a;
    return map;
  }, [film.assets]);

  const voiceObjects = film.objects.filter((o) => o.type === "voice");
  const musicObjects = film.objects.filter((o) => o.type === "music");
  const captionObjects = film.objects.filter((o) => o.type === "caption");
  const filmMs = film.objects.reduce((n, o) => Math.max(n, ms(o.startMs) + ms(o.durationMs)), 0);

  useEffect(() => {
    apiGet("/creative/voices")
      .then((res: any) => setVoices(res.voices || []))
      .catch(() => setVoices([]));
    return () => clearInterval(pollRef.current);
  }, []);

  /* ---- making a piece of sound ------------------------------------- */

  const place = useCallback(
    async (kind: "voice" | "music", asset: any) => {
      const durationMs = ms(asset.durationMs) || (kind === "music" ? musicSeconds * 1000 : 4000);
      // Voice lands after whatever voice is already there; music starts at the
      // top and runs under the whole film.
      const startMs = kind === "voice" ? voiceObjects.reduce((n, o) => Math.max(n, ms(o.startMs) + ms(o.durationMs)), 0) : 0;
      await film.apply([
        {
          op: "add",
          payload: {
            id: newId(kind === "voice" ? "v" : "m"),
            type: kind,
            track: kind === "voice" ? 3 : 4,
            assetId: asset.id,
            startMs,
            durationMs,
            gain: kind === "music" ? 0.18 : 0.95,
            duck: kind === "music",
            name: kind === "voice" ? "Voiceover" : "Music",
          },
          summary: kind === "voice" ? "Voiceover added" : "Music added",
        },
      ]);
      return { startMs, durationMs };
    },
    // film.apply changes with every revision; the values it closes over are read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [film.apply, voiceObjects, musicSeconds],
  );

  const poll = useCallback(
    (jobId: string, kind: "voice" | "music", scriptAtTime: string) => {
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const res: any = await apiGet(`/creative/jobs/${jobId}`);
          setJob(res.job);
          if (["succeeded", "failed", "cancelled"].includes(res.job.status)) {
            clearInterval(pollRef.current);
            const asset = (res.assets || [])[0];
            if (res.job.status === "succeeded" && asset) {
              const placed = await place(kind, asset);
              await film.reload();
              if (kind === "voice") {
                setNote(`The voiceover is on the film — ${fmtDuration(placed.durationMs)}. Captions can be made from it below.`);
                // Remember what was said, so "make captions" has the words.
                setScript(scriptAtTime);
              } else {
                setNote("The music is on the film, sitting under the voice.");
              }
            }
          }
        } catch {
          /* retried next tick */
        }
      }, 3000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [place],
  );

  const speak = async () => {
    if (!script.trim()) return setErr("Write what it should say first.");
    setErr("");
    setNote("");
    setBusy(true);
    setWhat("voice");
    try {
      const res: any = await apiPost("/creative/jobs", {
        capability: "audio.speech",
        projectId,
        text: script.trim(),
        request: script.trim().slice(0, 200),
        voiceId: voiceId || undefined,
      });
      setJob(res.job);
      poll(res.job.id, "voice", script.trim());
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const makeMusic = async () => {
    if (!musicBrief.trim()) return setErr("Say what the music should feel like.");
    setErr("");
    setNote("");
    setBusy(true);
    setWhat("music");
    try {
      const res: any = await apiPost("/creative/jobs", {
        capability: "audio.music",
        projectId,
        request: musicBrief.trim(),
        durationMs: Math.max(5, Math.min(120, musicSeconds)) * 1000,
      });
      setJob(res.job);
      poll(res.job.id, "music", script);
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---- captions ----------------------------------------------------- */

  const makeCaptions = async () => {
    const voiceObj = voiceObjects[0];
    const words = script.trim();
    if (!words) return setErr("Captions come from the voiceover script — write it above first.");
    setErr("");
    const spanMs = voiceObj ? ms(voiceObj.durationMs) : Math.max(4000, filmMs || 15000);
    const from = voiceObj ? ms(voiceObj.startMs) : 0;
    const cues = captionCues(captionLines(words), spanMs, from);
    const ops: any[] = captionObjects.map((c) => ({ op: "delete", target: c.id, summary: "Old caption removed" }));
    for (const cue of cues) {
      ops.push({
        op: "add",
        payload: { id: newId("cap"), type: "caption", track: 2, startMs: cue.startMs, durationMs: cue.endMs - cue.startMs, endMs: cue.endMs, text: cue.text, name: cue.text },
        summary: "Caption added",
      });
    }
    const ok = await film.apply(ops);
    if (ok) setNote(`${cues.length} captions laid across the voiceover.`);
  };

  const removeObject = async (id: string) => film.apply([{ op: "delete", target: id, summary: "Removed" }]);

  /* ---- screens ------------------------------------------------------ */

  if (!projectId) return <NoProject projects={film.projects} loading={film.loading} onPicked={(id) => router.push(`/creative/audio?project=${id}`)} />;
  if (film.loading) return <LoadingCard rows={4} />;
  if (!film.project) return <Note kind="bad">{film.error || "That project is not there."}</Note>;

  return (
    <>
      <PageHead
        crumb={["Creative Studio", film.project.title, "Voice, music & captions"]}
        title="Voice, music & captions"
        subtitle="Everything that goes under the picture. Each piece lands on the film as soon as it is made."
        actions={
          <>
            <Link className="cse-btn" href={`/creative/storyboard?project=${encodeURIComponent(projectId)}`}>Storyboard</Link>
            <Link className="cse-btn primary" href={`/creative/timeline?project=${encodeURIComponent(projectId)}`}>Open the editor</Link>
          </>
        }
      />

      {film.overtaken ? <Note kind="warn">Somebody — or the Coworker — changed this film while you had it open. You are looking at their version now.</Note> : null}
      {err ? <Note kind="bad">{err}</Note> : null}
      {note ? <Note kind="ok">{note}</Note> : null}
      {film.error ? <Note kind="bad">{film.error}</Note> : null}
      {job && !["succeeded", "failed", "cancelled"].includes(job.status) ? (
        <Card title={what === "music" ? "Writing the music" : "Reading the script"}>
          <JobProgress job={job} onCancel={async () => { try { await apiPost(`/creative/jobs/${job.id}/cancel`, {}); } catch { /* the page still works */ } }} />
        </Card>
      ) : null}
      {job?.status === "failed" ? <Note kind="bad">{job.error || "That did not work."}</Note> : null}

      <div className="cse-grid g2" style={{ alignItems: "start" }}>
        <Card title="Voiceover" sub="Written by you, read aloud">
          <div className="cse-stack">
            <label className="cse-fld">
              What it should say
              <textarea
                className="cse-input"
                rows={5}
                value={script}
                maxLength={5000}
                placeholder="Your phones never sleep. Neither do we."
                onChange={(e) => setScript(e.target.value)}
              />
            </label>
            <label className="cse-fld">
              Voice
              <ConnectSelect
                ariaLabel="Voice"
                value={voiceId}
                onChange={setVoiceId}
                options={[
                  { value: "", label: "Loopcom's usual voice" },
                  ...voices.map((v) => ({ value: v.voiceId, label: `${v.name}${v.labels?.accent ? ` · ${v.labels.accent}` : ""}` })),
                ]}
              />
              {!voices.length ? <span className="cse-help">The voice list could not be loaded, so the usual voice will be used.</span> : null}
            </label>
            <div className="cse-row">
              <span className="cse-help">{script.trim().length} characters</span>
              <button type="button" className="cse-btn primary sm" style={{ marginLeft: "auto" }} onClick={speak} disabled={busy}>
                {busy && what === "voice" ? "Starting…" : "Read it aloud"}
              </button>
            </div>
          </div>

          {voiceObjects.length ? (
            <div className="cse-stack" style={{ marginTop: 12 }}>
              {voiceObjects.map((o) => {
                const asset = o.assetId ? assetsById[String(o.assetId)] : null;
                return (
                  <div className="cse-row" key={o.id}>
                    <Pill kind="ok">Voice</Pill>
                    {asset ? <audio src={asset.url} controls preload="none" style={{ height: 32, flex: 1 }} /> : <span className="cse-muted">Placed</span>}
                    <span className="cse-muted" style={{ fontSize: 12 }}>{fmtDuration(o.durationMs)}</span>
                    <button type="button" className="cse-btn sm" onClick={() => removeObject(o.id)}>Remove</button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </Card>

        <Card title="Music" sub="Sits under the voice automatically">
          <div className="cse-stack">
            <label className="cse-fld">
              What it should feel like
              <textarea
                className="cse-input"
                rows={3}
                value={musicBrief}
                maxLength={600}
                placeholder="Slow build, warm and hopeful, no vocals, ends cleanly"
                onChange={(e) => setMusicBrief(e.target.value)}
              />
            </label>
            <label className="cse-fld">
              How long
              <ConnectSelect
                ariaLabel="How long"
                value={String(musicSeconds)}
                onChange={(v) => setMusicSeconds(Number(v))}
                options={[10, 15, 20, 30, 45, 60].map((n) => ({ value: String(n), label: `${n} seconds` }))}
                placeholder={`${musicSeconds} seconds`}
              />
            </label>
            <div className="cse-row">
              <span className="cse-help">Made for this film — nothing to license.</span>
              <button type="button" className="cse-btn primary sm" style={{ marginLeft: "auto" }} onClick={makeMusic} disabled={busy}>
                {busy && what === "music" ? "Starting…" : "Write the music"}
              </button>
            </div>
          </div>

          {musicObjects.length ? (
            <div className="cse-stack" style={{ marginTop: 12 }}>
              {musicObjects.map((o) => {
                const asset = o.assetId ? assetsById[String(o.assetId)] : null;
                return (
                  <div className="cse-row" key={o.id}>
                    <Pill kind="info">Music</Pill>
                    {asset ? <audio src={asset.url} controls preload="none" style={{ height: 32, flex: 1 }} /> : <span className="cse-muted">Placed</span>}
                    <span className="cse-muted" style={{ fontSize: 12 }}>{fmtDuration(o.durationMs)}</span>
                    <button type="button" className="cse-btn sm" onClick={() => removeObject(o.id)}>Remove</button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </Card>
      </div>

      <Card
        title="Captions"
        sub="Burned into the picture, and saved as a .srt beside it"
        end={<button type="button" className="cse-btn sm" onClick={makeCaptions}>Make them from the script</button>}
      >
        {captionObjects.length ? (
          <div className="cse-stack">
            {captionObjects
              .slice()
              .sort((a, b) => ms(a.startMs) - ms(b.startMs))
              .map((c) => (
                <div className="cse-row" key={c.id}>
                  <span className="cse-num cse-muted" style={{ width: 96, fontSize: 12 }}>
                    {(ms(c.startMs) / 1000).toFixed(1)}–{(ms(c.endMs ?? ms(c.startMs) + ms(c.durationMs)) / 1000).toFixed(1)}s
                  </span>
                  <input
                    className="cse-input"
                    style={{ flex: 1 }}
                    defaultValue={String(c.text || "")}
                    onBlur={(e) => { if (e.target.value !== c.text) film.apply([{ op: "set", target: c.id, payload: { text: e.target.value.slice(0, 300), name: e.target.value.slice(0, 60) }, summary: "Caption changed" }]); }}
                  />
                  <button type="button" className="cse-btn sm" onClick={() => removeObject(c.id)}>Remove</button>
                </div>
              ))}
            <div className="cse-row">
              <label className="cse-row" style={{ gap: 8 }}>
                <input type="checkbox" checked={film.doc?.doc?.burnCaptions !== false} onChange={(e) => film.setDocFields({ burnCaptions: e.target.checked })} />
                <span>Burn them into the picture</span>
              </label>
              <span className="cse-help" style={{ marginLeft: "auto" }}>The .srt is saved either way.</span>
            </div>
          </div>
        ) : (
          <EmptyState title="No captions yet" text="Write the voiceover script above, then make the captions from it — they are laid across the spoken audio's real length, so they stay in time." />
        )}
      </Card>
    </>
  );
}

function NoProject({ projects, loading, onPicked }: { projects: any[]; loading: boolean; onPicked: (id: string) => void }) {
  return (
    <>
      <PageHead crumb={["Creative Studio", "Voice, music & captions"]} title="Voice, music & captions" subtitle="Sound belongs to a film. Pick the project you are working on." />
      {loading ? <LoadingCard /> : projects.length ? (
        <Card title="Your projects">
          <div className="cse-stack">
            {projects.map((p) => (
              <div className="cse-row" key={p.id}>
                <b style={{ fontSize: 13 }}>{p.title}</b>
                <button type="button" className="cse-btn sm" style={{ marginLeft: "auto" }} onClick={() => onPicked(p.id)}>Open</button>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState title="No films yet" text="Start one in the storyboard." action={<Link className="cse-btn primary" href="/creative/storyboard">Open the storyboard</Link>} />
      )}
    </>
  );
}
