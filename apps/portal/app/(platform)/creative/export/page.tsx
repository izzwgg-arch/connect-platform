"use client";
/**
 * Creative Studio — export.
 *
 * Pick what is going out and where it is going; one file per destination, made
 * on our own machines with FFmpeg. Video is filled and cropped to the shape,
 * never stretched, and loudness-matched; a still is resized.
 *
 * ⛔ NOTHING here posts anything anywhere. Export makes a file and hands it to
 * the person — no tool in this platform publishes on a customer's behalf, and a
 * test asserts no such tool exists. That is deliberate: an agent that can post
 * to a company's channels is a different product with a different risk.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { AssetThumb, Card, EmptyState, LoadingCard, Note, PageHead, Pill, errText, fmtBytes, fmtDuration, fmtWhen } from "../CreativeUi";

interface Preset {
  id: string;
  label: string;
  width: number;
  height: number;
  kind: "video" | "image";
}

export default function CreativeExportPage() {
  return (
    <PermissionGate
      permission="can_view_creative_export"
      fallback={<div className="cse"><EmptyState title="Export isn't on for your account" text="An admin at your company can switch it on." /></div>}
    >
      <div className="cse">
        <ExportScreen />
      </div>
    </PermissionGate>
  );
}

function ExportScreen() {
  const params = useSearchParams();
  const projectId = params?.get("project") || "";
  const wanted = params?.get("asset") || "";

  const [presets, setPresets] = useState<Preset[]>([]);
  const [assets, setAssets] = useState<any[]>([]);
  const [exports, setExports] = useState<any[]>([]);
  const [sel, setSel] = useState(wanted);
  const [picked, setPicked] = useState<string[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const pollRef = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const query = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
      const [p, made, done]: any[] = await Promise.all([
        apiGet("/creative/export-presets"),
        apiGet(`/creative/assets?limit=60${query}`),
        apiGet(`/creative/assets?source=exported&limit=30${query}`),
      ]);
      setPresets(p.presets || []);
      setAssets((made.assets || []).filter((a: any) => a.kind === "video" || a.kind === "image"));
      setExports(done.assets || []);
      setSel((current) => current || wanted || (made.assets || [])[0]?.id || "");
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, wanted]);

  useEffect(() => {
    load();
    return () => clearInterval(pollRef.current);
  }, [load]);

  const selected = assets.find((a) => a.id === sel) || null;
  // A still cannot become a video, so only the shapes that make sense are offered.
  const usable = presets.filter((p) => (selected?.kind === "image" ? p.kind === "image" : true));

  const toggle = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const start = async () => {
    if (!selected) return setErr("Pick what you want to export.");
    if (!picked.length) return setErr("Pick at least one place it is going.");
    setErr("");
    setNote("");
    setBusy(true);
    try {
      const res: any = await apiPost("/creative/export", { assetId: selected.id, presets: picked, projectId: projectId || undefined });
      // jobSummary deliberately does not echo the request, so the destination
      // is carried alongside — the jobs come back in the order they were asked for.
      const withPreset = (res.jobs || []).map((j: any, i: number) => ({ ...j, preset: picked[i] }));
      setJobs(withPreset);
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        const updated = await Promise.all(
          withPreset.map(async (j: any) => {
            try {
              const got: any = await apiGet(`/creative/jobs/${j.id}`);
              return { ...got.job, preset: j.preset };
            } catch {
              return j;
            }
          }),
        );
        setJobs(updated);
        if (updated.every((j: any) => ["succeeded", "failed", "cancelled"].includes(j.status))) {
          clearInterval(pollRef.current);
          const ok = updated.filter((j: any) => j.status === "succeeded").length;
          setNote(ok ? `${ok} file${ok === 1 ? "" : "s"} ready below. Download and post ${ok === 1 ? "it" : "them"} yourself — Loopcom never posts anything for you.` : "");
          load();
        }
      }, 2500);
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingCard rows={4} />;

  return (
    <>
      <PageHead
        crumb={["Creative Studio", "Export"]}
        title="Export"
        subtitle="One file per place it is going, cropped to fit rather than stretched."
        actions={projectId ? <Link className="cse-btn" href={`/creative/timeline?project=${encodeURIComponent(projectId)}`}>Back to the editor</Link> : null}
      />

      {err ? <Note kind="bad">{err}</Note> : null}
      {note ? <Note kind="ok">{note}</Note> : null}

      {!assets.length ? (
        <EmptyState
          title="Nothing to export yet"
          text="Make an image or render a film first, and it will be here."
          action={<Link className="cse-btn primary" href="/creative/images">Make an image</Link>}
        />
      ) : (
        <>
          <Card title="What is going out" sub={selected ? `${selected.name} · ${fmtBytes(selected.bytes)}${selected.durationMs ? ` · ${fmtDuration(selected.durationMs)}` : ""}` : "Pick one"}>
            <div className="cse-rowscroll">
              {assets.map((a) => (
                <div key={a.id} style={{ width: 130, flex: "0 0 auto" }}>
                  <AssetThumb asset={a} shape="sq" selected={a.id === sel} onClick={() => { setSel(a.id); setPicked([]); }} />
                  <p className="cse-help" style={{ marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</p>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Where it is going" sub="Tick every place — each one is its own file">
            <div className="cse-tiles">
              {usable.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`cse-tile ${picked.includes(p.id) ? "on" : ""}`}
                  onClick={() => toggle(p.id)}
                  aria-pressed={picked.includes(p.id)}
                >
                  <b>{p.label}</b>
                  <span className="cse-help">{p.width}×{p.height} · {p.kind === "video" ? "video" : "still"}</span>
                </button>
              ))}
            </div>
            <div className="cse-row" style={{ marginTop: 12 }}>
              <span className="cse-help">{picked.length ? `${picked.length} selected` : "Nothing selected yet"}</span>
              <button type="button" className="cse-btn primary" style={{ marginLeft: "auto" }} onClick={start} disabled={busy || !picked.length}>
                {busy ? "Starting…" : `Export ${picked.length || ""}`.trim()}
              </button>
            </div>
          </Card>

          {jobs.length ? (
            <Card title="Making the files">
              <div className="cse-stack">
                {jobs.map((j) => (
                  <div className="cse-row" key={j.id}>
                    <Pill kind={j.status === "succeeded" ? "ok" : j.status === "failed" ? "bad" : "warn"}>
                      {j.status === "succeeded" ? "Ready" : j.status === "failed" ? "Failed" : j.note || "Working"}
                    </Pill>
                    <span className="cse-muted" style={{ fontSize: 12 }}>{presets.find((p) => p.id === j.preset)?.label || j.capability}</span>
                    {j.error ? <span className="cse-help">{j.error}</span> : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </>
      )}

      <Card title="Already exported" sub="Downloads are links that expire — take a copy">
        {exports.length ? (
          <div className="cse-stack">
            {exports.map((a) => (
              <div className="cse-row" key={a.id}>
                <div style={{ width: 92 }}>
                  <AssetThumb asset={a} shape="sq" />
                </div>
                <div style={{ flex: 1 }}>
                  <b style={{ fontSize: 13 }}>{a.name}</b>
                  <p className="cse-help">{a.width}×{a.height} · {fmtBytes(a.bytes)} · {fmtWhen(a.createdAt)}</p>
                </div>
                <a className="cse-btn sm" href={a.url} download={a.name} target="_blank" rel="noreferrer">Download</a>
              </div>
            ))}
          </div>
        ) : (
          <p className="cse-help">Nothing exported yet.</p>
        )}
      </Card>
    </>
  );
}
