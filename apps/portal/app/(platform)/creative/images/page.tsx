"use client";
/**
 * Creative Studio — the image generator.
 *
 * Simple controls first, technical ones behind Advanced, exactly as the
 * approved mockup has it. The job is created, then polled: the page can be
 * closed and the picture is still there when it comes back.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { AssetThumb, Card, EmptyState, JobProgress, Note, PageHead, Pill, errText, money } from "../CreativeUi";

const MODES = [
  { id: "create", label: "Create", capability: "image.generate" },
  { id: "edit", label: "Edit", capability: "image.edit" },
  { id: "background", label: "Replace background", capability: "image.edit" },
  { id: "variations", label: "Variations", capability: "image.edit" },
];

const RATIOS = ["1:1", "4:5", "16:9", "9:16", "3:2"];
const STYLES = ["On brand", "Photographic", "Cinematic", "Product studio", "Illustration", "Flat graphic"];

export default function CreativeImagesPage() {
  const params = useSearchParams();
  const projectId = params?.get("project") || "";

  const [mode, setMode] = useState("create");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("4:5");
  const [style, setStyle] = useState("On brand");
  const [count, setCount] = useState(2);
  const [quality, setQuality] = useState<"low" | "medium" | "high">("low");
  const [refIds, setRefIds] = useState<string[]>([]);
  const [job, setJob] = useState<any>(null);
  const [results, setResults] = useState<any[]>([]);
  const [library, setLibrary] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [applied, setApplied] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const pollRef = useRef<any>(null);

  const loadLibrary = useCallback(async () => {
    try {
      const res: any = await apiGet(`/creative/assets?kind=image&limit=24${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`);
      setLibrary(res.assets || []);
    } catch {
      /* the library is a convenience; a failure here must not block making things */
    }
  }, [projectId]);

  useEffect(() => {
    loadLibrary();
    return () => clearInterval(pollRef.current);
  }, [loadLibrary]);

  const poll = useCallback((jobId: string) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res: any = await apiGet(`/creative/jobs/${jobId}`);
        setJob(res.job);
        if (res.job.status === "succeeded") {
          clearInterval(pollRef.current);
          setResults(res.assets || []);
          setBusy(false);
          loadLibrary();
        } else if (res.job.status === "failed" || res.job.status === "cancelled") {
          clearInterval(pollRef.current);
          setBusy(false);
        }
      } catch {
        /* keep polling: a blip must not look like a failed render */
      }
    }, 1500);
  }, [loadLibrary]);

  const generate = async () => {
    if (!prompt.trim()) return;
    setErr("");
    setBusy(true);
    setResults([]);
    try {
      const body: any = {
        capability: mode === "create" ? "image.generate" : "image.edit",
        request: prompt.trim(),
        ratio,
        quality,
        count,
        styleHint: style === "On brand" ? undefined : style,
        referenceAssetIds: refIds,
      };
      if (projectId) body.projectId = projectId;
      const res: any = await apiPost("/creative/jobs", body);
      setJob(res.job);
      setApplied(res.appliedMemory || []);
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
      /* the sweep will finish it either way */
    }
    clearInterval(pollRef.current);
    setBusy(false);
  };

  const feedback = async (assetId: string, signal: "accept" | "reject", reasonCodes: string[] = []) => {
    try {
      const res: any = await apiPost("/creative/feedback", { subjectType: "asset", subjectId: assetId, signal, reasonCodes, projectId: projectId || undefined, detail: { style } });
      if (res?.learned?.length) setApplied((prev) => [...new Set([...prev, ...res.learned.map((l: any) => l.statement)])]);
    } catch {
      /* feedback is best-effort; never block the person */
    }
  };

  return (
    <PermissionGate permission="can_view_creative_images" fallback={<div className="cse"><EmptyState title="Images aren't on for your account" text="An admin at your company can switch them on." /></div>}>
      <div className="cse">
        <PageHead
          title="Images"
          crumb={["Creative Studio", "Images"]}
          subtitle="Type what you want. The studio adds your brand and what it has learned about your taste before it asks the engine."
        />

        {err ? <Note kind="bad">{err}</Note> : null}

        <div className="cse-genlay">
          <div className="cse-gpanel">
            <div className="cse-tabs" role="tablist">
              {MODES.map((m) => (
                <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>

            <label className="cse-fld">
              What do you want?
              <textarea
                className="cse-input"
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Our desk phone on a clean desk in a small shop, morning light, room for a headline on the left."
              />
            </label>

            <div>
              <div className="cse-seclbl">Shape</div>
              <div className="cse-chips">
                {RATIOS.map((r) => (
                  <button key={r} type="button" className={`cse-chip ${ratio === r ? "on" : ""}`} onClick={() => setRatio(r)}>
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="cse-seclbl">Look</div>
              <div className="cse-chips">
                {STYLES.map((s) => (
                  <button key={s} type="button" className={`cse-chip ${style === s ? "on" : ""}`} onClick={() => setStyle(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="cse-seclbl">How many</div>
              <div className="cse-chips">
                {[1, 2, 4].map((n) => (
                  <button key={n} type="button" className={`cse-chip ${count === n ? "on" : ""}`} onClick={() => setCount(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {refIds.length ? (
              <Note kind="info">
                {refIds.length} reference {refIds.length === 1 ? "picture" : "pictures"} will be used.
                <button type="button" className="cse-btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setRefIds([])}>
                  Clear
                </button>
              </Note>
            ) : null}

            <details className="cse-adv">
              <summary>Advanced</summary>
              <div className="body">
                <label className="cse-fld">
                  Quality
                  <select className="cse-input" value={quality} onChange={(e) => setQuality(e.target.value as any)}>
                    <option value="low">Quick and cheap</option>
                    <option value="medium">Better</option>
                    <option value="high">Best — slowest and dearest</option>
                  </select>
                </label>
                <span className="cse-help">
                  The studio never asks an engine for another company&apos;s logo or a real named person, whatever is typed here.
                </span>
              </div>
            </details>

            <div className="cse-cost">
              <div>
                <b>{count} {count === 1 ? "image" : "images"}</b>
                <div className="cse-help">{quality === "low" ? "about 10 seconds" : quality === "medium" ? "about 20 seconds" : "up to a minute"}</div>
              </div>
              <button type="button" className="cse-btn primary" style={{ marginLeft: "auto" }} disabled={busy || !prompt.trim()} onClick={generate}>
                {busy ? "Making…" : "Make them"}
              </button>
            </div>
          </div>

          <div className="cse-stack">
            <Card
              title={results.length ? "Your pictures" : "Results"}
              sub={results.length ? "Tell it which ones are good — that is what teaches it" : "They appear here"}
              end={job?.costMicros ? <Pill kind="nub">{money(job.costMicros)}</Pill> : null}
            >
              {busy || (job && job.status !== "succeeded" && job.status !== "failed") ? (
                <JobProgress job={job} onCancel={cancel} />
              ) : results.length ? (
                <>
                  <div className="cse-resgrid">
                    {results.map((a: any) => (
                      <div key={a.id} className={`cse-res ${selected === a.id ? "on" : ""}`}>
                        <AssetThumb asset={a} shape={ratio === "1:1" ? "sq" : ratio === "4:5" ? "p45" : undefined} onClick={() => setSelected(a.id)} />
                        <div className="cse-row" style={{ padding: 8, gap: 6 }}>
                          <button type="button" className="cse-btn sm" onClick={() => feedback(a.id, "accept")}>
                            Good
                          </button>
                          <button type="button" className="cse-btn sm" onClick={() => feedback(a.id, "reject", ["wrong_feeling"])}>
                            Not right
                          </button>
                          <a className="cse-btn sm ghost" href={a.url} download={a.name} style={{ marginLeft: "auto" }}>
                            Save
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                  {applied.length ? (
                    <Note kind="info" >
                      <div>
                        <b>What it used:</b> {applied.join(" · ")}
                      </div>
                    </Note>
                  ) : null}
                </>
              ) : job?.status === "failed" ? (
                <JobProgress job={job} />
              ) : (
                <EmptyState title="Nothing made yet" text="Describe what you want on the left and press Make them." />
              )}
            </Card>

            <Card title="Your pictures" sub="Everything this company has made or uploaded" end={<a className="cse-btn sm ghost" href="/creative/assets">Asset library</a>}>
              {library.length ? (
                <div className="cse-resgrid">
                  {library.map((a: any) => (
                    <div key={a.id} className="cse-res">
                      <AssetThumb asset={a} onClick={() => setRefIds((prev) => (prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id].slice(0, 4)))} selected={refIds.includes(a.id)} />
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="Nothing in the library yet" text="Pictures you make or upload live here, and can be used as references." />
              )}
            </Card>
          </div>
        </div>
      </div>
    </PermissionGate>
  );
}
