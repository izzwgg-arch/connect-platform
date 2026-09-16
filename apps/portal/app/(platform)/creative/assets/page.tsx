"use client";
/**
 * Creative Studio — the asset library.
 *
 * Everything this company has uploaded or made. Uploads are checked by their
 * bytes on the server, not by their name, and every file belongs to exactly
 * one company.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiDelete } from "../../../../services/apiClient";
import { AssetThumb, Card, EmptyState, LoadingCard, Note, PageHead, Pill, errText, fmtBytes, fmtWhen } from "../CreativeUi";

const FILTERS: Array<[string, string]> = [
  ["", "Everything"],
  ["image", "Images"],
  ["video", "Video"],
  ["audio", "Audio"],
  ["doc", "Files"],
];

export default function CreativeAssetsPage() {
  const [kind, setKind] = useState("");
  const [source, setSource] = useState("");
  const [assets, setAssets] = useState<any[]>([]);
  const [storage, setStorage] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: "100" });
      if (kind) q.set("kind", kind);
      if (source) q.set("source", source);
      const [res, st]: any[] = await Promise.all([apiGet(`/creative/assets?${q}`), apiGet("/creative/storage").catch(() => null)]);
      setAssets(res.assets || []);
      setStorage(st);
      setErr("");
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [kind, source]);

  useEffect(() => {
    load();
  }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setErr("");
    setNote("");
    let ok = 0;
    for (const file of Array.from(files).slice(0, 10)) {
      try {
        const form = new FormData();
        form.append("file", file);
        // Multipart, so this goes through fetch rather than the JSON client.
        const res = await fetch("/api/creative/uploads", { method: "POST", body: form, credentials: "include" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.reason || body.error || `Upload failed (${res.status})`);
        }
        ok++;
      } catch (e: any) {
        setErr(`${file.name}: ${e.message || "could not be uploaded"}`);
      }
    }
    if (ok) setNote(`${ok} file${ok === 1 ? "" : "s"} added.`);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    load();
  };

  const remove = async (asset: any) => {
    if (!confirm(`Delete "${asset.name}"? This cannot be undone.`)) return;
    try {
      await apiDelete(`/creative/assets/${asset.id}`);
      load();
    } catch (e: any) {
      setErr(errText(e));
    }
  };

  return (
    <PermissionGate permission="can_view_creative_assets" fallback={<div className="cse"><EmptyState title="The asset library isn't on for your account" text="An admin at your company can switch it on." /></div>}>
      <div className="cse">
        <PageHead
          title="Assets"
          crumb={["Creative Studio", "Assets"]}
          subtitle="Everything you have uploaded or made. Files are stored per company — nobody outside your company can list them or link to them."
          actions={
            <>
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => upload(e.target.files)} accept="image/*,video/*,audio/*,.pdf,.ttf,.otf,.woff,.woff2" />
              <button type="button" className="cse-btn" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? "Uploading…" : "Upload"}
              </button>
              <a className="cse-btn primary" href="/creative/images">Make an image</a>
            </>
          }
        />

        {err ? <Note kind="bad">{err}</Note> : null}
        {note ? <Note kind="ok">{note}</Note> : null}

        <div className="cse-row wrap" style={{ marginBottom: 12 }}>
          <div className="cse-chips">
            {FILTERS.map(([k, label]) => (
              <button key={label} type="button" className={`cse-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="cse-chips" style={{ marginLeft: "auto" }}>
            {[["", "Any source"], ["generated", "Made here"], ["uploaded", "Uploaded"], ["exported", "Exported"]].map(([s, label]) => (
              <button key={label} type="button" className={`cse-chip ${source === s ? "on" : ""}`} onClick={() => setSource(s)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {storage ? (
          <Note kind="info">
            <div>
              Using <b>{fmtBytes(storage.bytes)}</b> of {storage.limitGb} GB. Rejected takes and working files are cleared automatically; anything you keep stays.
            </div>
          </Note>
        ) : null}

        {loading ? (
          <LoadingCard rows={4} />
        ) : assets.length ? (
          <div className="cse-resgrid" style={{ marginTop: 12 }}>
            {assets.map((a: any) => (
              <div key={a.id} className="cse-res">
                <AssetThumb asset={a} />
                <div style={{ padding: "8px 9px" }}>
                  <b style={{ fontSize: 12.5, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</b>
                  <div className="cse-row" style={{ marginTop: 4 }}>
                    <span className="cse-help">{fmtBytes(a.bytes)} · {fmtWhen(a.createdAt)}</span>
                    <Pill kind={a.source === "generated" ? "info" : a.source === "exported" ? "ok" : "nub"}>{a.source}</Pill>
                  </div>
                  <div className="cse-row" style={{ marginTop: 6, gap: 6 }}>
                    <a className="cse-btn sm ghost" href={a.url} download={a.name}>Save</a>
                    <button type="button" className="cse-btn sm ghost danger" style={{ marginLeft: "auto" }} onClick={() => remove(a)}>Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="Nothing here yet"
            text="Upload your logo, product photos and anything else you want the studio to work from — or make something and it lands here."
            action={
              <button type="button" className="cse-btn primary sm" onClick={() => fileRef.current?.click()}>
                Upload files
              </button>
            }
          />
        )}

        <Card title="What can be uploaded" className="cse-mt" >
          <div className="cse-row wrap">
            {["Images (PNG, JPG, WebP, GIF)", "Video (MP4, WebM)", "Audio (MP3, WAV, OGG)", "Fonts", "PDF"].map((t) => (
              <Pill key={t} kind="nub">{t}</Pill>
            ))}
          </div>
          <p className="cse-help" style={{ marginTop: 8 }}>
            Every file is checked by what it really is, not by its name, and re-encoded where we can. Anything else is refused.
          </p>
        </Card>
      </div>
    </PermissionGate>
  );
}
