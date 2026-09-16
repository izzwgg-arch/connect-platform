"use client";
/**
 * Creative Studio — the video generator.
 *
 * Draft and Production, exactly as the approved mockup has it. The engine's
 * own clip lengths (4, 8 or 12 seconds) are deliberately NOT shown: you ask for
 * the seconds you want up to 15 and Loopcom composes it, which is the whole
 * point of having an orchestrator.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { AssetThumb, Card, EmptyState, JobProgress, Note, PageHead, Pill, errText, money } from "../CreativeUi";

const RATIOS: Array<[string, string]> = [["16:9", "Landscape"], ["9:16", "Status, Reels, TikTok"], ["1:1", "Square"], ["4:5", "Feed"]];
const CAMERA = ["Locked off", "Slow push-in", "Pull back", "Pan left", "Pan right", "Handheld", "Orbit"];
const LOOKS = ["On brand", "Cinematic", "Documentary", "Product", "Graphic"];

export default function CreativeVideoPage() {
  const params = useSearchParams();
  const projectId = params?.get("project") || "";

  const [mode, setMode] = useState<"draft" | "production">("draft");
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(8);
  const [ratio, setRatio] = useState("16:9");
  const [camera, setCamera] = useState("Slow push-in");
  const [look, setLook] = useState("On brand");
  const [firstFrame, setFirstFrame] = useState("");
  const [job, setJob] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [stills, setStills] = useState<any[]>([]);
  const [clips, setClips] = useState<any[]>([]);
  const [engines, setEngines] = useState<any[]>([]);
  const [quota, setQuota] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const [assets, vids, eng, overview]: any[] = await Promise.all([
        apiGet("/creative/assets?kind=image&limit=12"),
        apiGet("/creative/assets?kind=video&limit=12"),
        apiGet("/creative/engines"),
        apiGet("/creative/overview"),
      ]);
      setStills(assets.assets || []);
      setClips(vids.assets || []);
      setEngines(eng.engines || []);
      setQuota(overview.quota);
    } catch {
      /* the page still works without these */
    }
  }, []);

  useEffect(() => {
    load();
    return () => clearInterval(pollRef.current);
  }, [load]);

  useEffect(() => {
    // Draft is for judging an idea; production is the real thing.
    setSeconds((s) => (mode === "draft" ? Math.min(8, s) : s));
  }, [mode]);

  const videoEngine = engines.find((e: any) => (e.capabilities || []).includes("video.generate"));
  const left = quota ? Math.max(0, quota.videoSeconds - (quota.used?.videoSeconds || 0)) : null;
  const estimate = mode === "draft" ? seconds * 0.04 : seconds * 0.1;

  const poll = (jobId: string) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res: any = await apiGet(`/creative/jobs/${jobId}`);
        setJob(res.job);
        if (res.job.status === "succeeded") {
          clearInterval(pollRef.current);
          setResult((res.assets || [])[0] || null);
          setBusy(false);
          load();
        } else if (res.job.status === "failed" || res.job.status === "cancelled") {
          clearInterval(pollRef.current);
          setBusy(false);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  };

  const render = async () => {
    if (!prompt.trim()) return;
    setErr("");
    setBusy(true);
    setResult(null);
    try {
      const body: any = {
        capability: "video.generate",
        request: `${prompt.trim()}${camera && camera !== "Locked off" ? `. Camera: ${camera.toLowerCase()}.` : ""}`,
        seconds,
        ratio,
        styleHint: look === "On brand" ? undefined : look,
        quality: mode === "draft" ? "low" : "high",
      };
      if (projectId) body.projectId = projectId;
      if (firstFrame) body.firstFrameAssetId = firstFrame;
      const res: any = await apiPost("/creative/jobs", body);
      setJob(res.job);
      poll(res.job.id);
    } catch (e: any) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      await apiPost(`/creative/jobs/${job.id}/cancel`, {});
    } catch {
      /* the sweep finishes it either way */
    }
    clearInterval(pollRef.current);
    setBusy(false);
  };

  return (
    <PermissionGate permission="can_view_creative_video" fallback={<div className="cse"><EmptyState title="Video isn't on for your account" text="An admin at your company can switch it on." /></div>}>
      <div className="cse">
        <PageHead
          title="Video"
          crumb={["Creative Studio", "Video"]}
          subtitle="One shot at a time, up to 15 seconds. A longer film is several shots — make them one by one and cut them together in the editor."
          actions={left != null ? <Pill kind={left > 20 ? "info" : "warn"}>{left}s left this month</Pill> : undefined}
        />

        {err ? <Note kind="bad">{err}</Note> : null}

        <div className="cse-genlay">
          <div className="cse-gpanel">
            <div>
              <div className="cse-tabs" role="tablist" style={{ width: "100%" }}>
                <button type="button" role="tab" aria-selected={mode === "draft"} style={{ flex: 1 }} onClick={() => setMode("draft")}>
                  Draft
                </button>
                <button type="button" role="tab" aria-selected={mode === "production"} style={{ flex: 1 }} onClick={() => setMode("production")}>
                  Production
                </button>
              </div>
              <p className="cse-help" style={{ marginTop: 6 }}>
                {mode === "draft"
                  ? "Quick and cheap, up to 8 seconds, so you can judge the idea before spending on the real render."
                  : "Full quality, up to 15 seconds, and it goes through every automatic check before you see it."}
              </p>
            </div>

            <label className="cse-fld">
              What happens in the shot?
              <textarea
                className="cse-input"
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="A small shop floor at night. One desk phone lights up and rings. Practical light, shallow depth of field."
              />
            </label>

            <div>
              <div className="cse-row">
                <span className="cse-seclbl" style={{ margin: 0 }}>Length</span>
                <span className="cse-pill nub cse-num" style={{ marginLeft: "auto" }}>{seconds}s</span>
              </div>
              <input
                className="cse-range"
                type="range"
                min={2}
                max={mode === "draft" ? 8 : 15}
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
              />
              <p className="cse-help">
                {seconds > 12
                  ? "Longer than one engine clip — Loopcom renders it in parts that continue from each other and joins them."
                  : mode === "draft"
                    ? "Draft tops out at 8 seconds."
                    : "15 seconds is the most any single shot can be."}
              </p>
            </div>

            <div>
              <div className="cse-seclbl">Shape</div>
              <div className="cse-chips">
                {RATIOS.map(([r, hint]) => (
                  <button key={r} type="button" className={`cse-chip ${ratio === r ? "on" : ""}`} onClick={() => setRatio(r)} title={hint}>
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="cse-seclbl">Camera</div>
              <div className="cse-chips">
                {CAMERA.map((c) => (
                  <button key={c} type="button" className={`cse-chip ${camera === c ? "on" : ""}`} onClick={() => setCamera(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="cse-seclbl">Look</div>
              <div className="cse-chips">
                {LOOKS.map((l) => (
                  <button key={l} type="button" className={`cse-chip ${look === l ? "on" : ""}`} onClick={() => setLook(l)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <details className="cse-adv">
              <summary>Advanced</summary>
              <div className="body">
                <div>
                  <div className="cse-seclbl">Start from one of your pictures</div>
                  {stills.length ? (
                    <div className="cse-chips">
                      {stills.slice(0, 6).map((a: any) => (
                        <button
                          key={a.id}
                          type="button"
                          className={`cse-chip ${firstFrame === a.id ? "on" : ""}`}
                          onClick={() => setFirstFrame(firstFrame === a.id ? "" : a.id)}
                        >
                          {a.name.slice(0, 18)}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="cse-help">Make an image first and it can be the opening frame.</span>
                  )}
                </div>
                {videoEngine ? (
                  <span className="cse-help">
                    Engine: {videoEngine.label}. {videoEngine.notes}
                  </span>
                ) : (
                  <Note kind="warn">No video engine is switched on for this platform yet.</Note>
                )}
              </div>
            </details>

            <div className="cse-cost">
              <div>
                <b>About ${estimate.toFixed(2)}</b>
                <div className="cse-help">{mode === "draft" ? "roughly a minute" : "a minute or two"}</div>
              </div>
              <button type="button" className="cse-btn primary" style={{ marginLeft: "auto" }} disabled={busy || !prompt.trim() || !videoEngine} onClick={render}>
                {busy ? "Rendering…" : "Render"}
              </button>
            </div>
          </div>

          <div className="cse-stack">
            <Card title="Preview" sub={result ? "Just rendered" : "What you make appears here"} end={job?.costMicros ? <Pill kind="nub">{money(job.costMicros)}</Pill> : null}>
              {busy || (job && job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled") ? (
                <>
                  <JobProgress job={job} onCancel={cancel} />
                  <Note kind="info" >
                    <div>Video takes a minute or two. You can leave this page — it keeps rendering and will be in your library when it is done.</div>
                  </Note>
                </>
              ) : result ? (
                <div className="cse-stack">
                  <AssetThumb asset={result} shape={ratio === "9:16" ? "v" : ratio === "1:1" ? "sq" : undefined} />
                  <div className="cse-row wrap">
                    <Pill kind="ok">{seconds}s</Pill>
                    <Pill kind="nub">{ratio}</Pill>
                    <a className="cse-btn sm" href={result.url} download={result.name}>Save</a>
                    <button type="button" className="cse-btn sm" onClick={render}>Another take</button>
                  </div>
                </div>
              ) : job?.status === "failed" ? (
                <JobProgress job={job} />
              ) : (
                <EmptyState title="Nothing rendered yet" text="Describe the shot on the left and press Render." />
              )}
            </Card>

            <Card title="Your clips" sub="Everything this company has rendered">
              {clips.length ? (
                <div className="cse-resgrid">
                  {clips.map((a: any) => (
                    <div key={a.id} className="cse-res">
                      <AssetThumb asset={a} />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="No clips yet" text="Rendered shots live here and can be cut together later." />
              )}
            </Card>
          </div>
        </div>
      </div>
    </PermissionGate>
  );
}
