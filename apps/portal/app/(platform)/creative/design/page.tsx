"use client";
/**
 * Creative Studio — the design editor.
 *
 * The important part is not the canvas: it is that a person and the Coworker
 * edit the SAME document through the same operations, against a revision
 * number. Drag something here and the agent's next change is written against
 * what you left behind — or refused, so it re-reads instead of overwriting you.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost, apiPut } from "../../../../services/apiClient";
import { Card, EmptyState, LoadingCard, Note, PageHead, Pill, errText } from "../CreativeUi";

interface Obj {
  id: string;
  type: "text" | "image" | "rect" | "button";
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  size?: number;
  weight?: number;
  color?: string;
  fill?: string;
  assetUrl?: string;
  name?: string;
}

const STARTER: { objects: Obj[] } = {
  objects: [
    { id: "bg", type: "rect", name: "Background", x: 0, y: 0, w: 100, h: 100, fill: "#0c1218" },
    { id: "head", type: "text", name: "Headline", x: 9, y: 58, w: 74, text: "Your phones never sleep.", size: 8, weight: 700, color: "#ffffff" },
    { id: "sub", type: "text", name: "Sub-line", x: 9, y: 76, w: 62, text: "Neither do we. Set up in a day.", size: 3, weight: 500, color: "rgba(255,255,255,.8)" },
    { id: "cta", type: "button", name: "Button", x: 9, y: 86, w: 26, h: 6.4, text: "Talk to us", size: 2.8 },
  ],
};

export default function CreativeDesignPage() {
  const params = useSearchParams();
  const projectId = params?.get("project") || "";

  const [doc, setDoc] = useState<{ objects: Obj[] } | null>(null);
  const [documentId, setDocumentId] = useState("");
  const [revision, setRevision] = useState(0);
  const [sel, setSel] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<any>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setDoc(STARTER);
      setLoading(false);
      return;
    }
    try {
      const res: any = await apiGet(`/creative/projects/${projectId}`);
      const canvas = (res.documents || []).find((d: any) => d.type === "canvas");
      if (canvas) {
        setDoc(canvas.doc?.objects ? canvas.doc : STARTER);
        setDocumentId(canvas.id);
        setRevision(canvas.revision);
      } else {
        const created: any = await apiPut(`/creative/projects/${projectId}/documents/canvas`, { doc: STARTER });
        setDoc(created.document.doc);
        setDocumentId(created.document.id);
        setRevision(created.document.revision);
      }
      setErr("");
    } catch (e: any) {
      setErr(errText(e));
      setDoc(STARTER);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Every change goes through the same door the Coworker uses. */
  const applyOps = async (ops: Array<{ op: string; target?: string; payload: any; summary?: string }>) => {
    if (!doc) return;
    // Optimistic locally so dragging feels immediate.
    const next = { ...doc, objects: doc.objects.map((o) => {
      const hit = ops.find((p) => p.target === o.id);
      return hit && hit.op !== "delete" ? { ...o, ...hit.payload } : o;
    }) };
    setDoc(next);
    if (!documentId) return;
    setSaving(true);
    try {
      const res: any = await apiPost(`/creative/documents/${documentId}/ops`, { baseRevision: revision, actorType: "user", ops });
      setRevision(res.revision);
      setDoc(res.doc);
      setLog((l) => [...ops.map((o) => `you · ${o.summary || `${o.op} ${o.target || ""}`} (rev ${res.revision})`), ...l].slice(0, 40));
    } catch (e: any) {
      const body = e?.body || e;
      if (body?.error === "stale_revision") {
        // Somebody (or the Coworker) changed it while we were working.
        setDoc(body.doc);
        setRevision(body.revision);
        setLog((l) => [`refused — somebody else changed it; re-read at rev ${body.revision}`, ...l].slice(0, 40));
      } else {
        setErr(errText(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const onPointerDown = (e: React.PointerEvent, o: Obj) => {
    setSel(o.id);
    const box = canvasRef.current?.getBoundingClientRect();
    if (!box) return;
    dragRef.current = { id: o.id, startX: e.clientX, startY: e.clientY, ox: o.x, oy: o.y, box };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !doc) return;
    const x = Math.max(-5, Math.min(100, d.ox + ((e.clientX - d.startX) / d.box.width) * 100));
    const y = Math.max(-5, Math.min(100, d.oy + ((e.clientY - d.startY) / d.box.height) * 100));
    setDoc({ ...doc, objects: doc.objects.map((o) => (o.id === d.id ? { ...o, x, y } : o)) });
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || !doc) return;
    const o = doc.objects.find((x) => x.id === d.id);
    if (!o || (Math.abs(o.x - d.ox) < 0.2 && Math.abs(o.y - d.oy) < 0.2)) return;
    applyOps([{ op: "move", target: o.id, payload: { x: o.x, y: o.y }, summary: `moved ${o.name || o.id}` }]);
  };

  const selected = doc?.objects.find((o) => o.id === sel);

  return (
    <PermissionGate permission="can_view_creative_design" fallback={<div className="cse"><EmptyState title="The design editor isn't on for your account" text="An admin at your company can switch it on." /></div>}>
      <div className="cse">
        <PageHead
          title="Design editor"
          crumb={["Creative Studio", "Design"]}
          subtitle="Drag anything. The Coworker edits this same design through the same operations, so you can hand it back and forth without either of you overwriting the other."
          actions={
            <>
              <Pill kind="nub">revision {revision}</Pill>
              {saving ? <Pill kind="info">saving…</Pill> : null}
            </>
          }
        />

        {err ? <Note kind="bad">{err}</Note> : null}
        {!projectId ? (
          <Note kind="warn">
            <div>This is a scratch canvas. Open a project to save your work: <b>Projects → open one → Make something</b>.</div>
          </Note>
        ) : null}

        {loading || !doc ? (
          <LoadingCard rows={3} />
        ) : (
          <div className="cse-edlay">
            <div className="cse-edpanel">
              <div className="cse-seclbl" style={{ margin: 0 }}>Layers</div>
              {[...doc.objects].reverse().map((o) => (
                <div key={o.id} className={`cse-layer ${sel === o.id ? "on" : ""}`} onClick={() => setSel(o.id)}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name || o.id}</span>
                  <span className="cse-help">{o.type}</span>
                </div>
              ))}
              <div className="cse-divider" />
              <button
                type="button"
                className="cse-btn sm"
                onClick={() => {
                  const id = `t${Date.now().toString(36)}`;
                  const obj: Obj = { id, type: "text", name: "New text", x: 12, y: 20, w: 60, text: "New text", size: 4, weight: 600, color: "#ffffff" };
                  setDoc({ ...doc, objects: [...doc.objects, obj] });
                  setSel(id);
                  applyOps([{ op: "add", payload: obj, summary: "added text" }]);
                }}
              >
                Add text
              </button>
            </div>

            <div>
              <div className="cse-canvaswrap">
                <div className="cse-canvas" ref={canvasRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
                  {doc.objects.map((o) => {
                    const base: any = { left: `${o.x}%`, top: `${o.y}%` };
                    if (o.w != null) base.width = `${o.w}%`;
                    if (o.h != null) base.height = `${o.h}%`;
                    if (o.type === "rect") base.background = o.fill;
                    if (o.type === "text") {
                      base.fontSize = `${o.size}cqw`;
                      base.fontWeight = o.weight;
                      base.color = o.color;
                      base.lineHeight = 1.1;
                    }
                    if (o.type === "button") {
                      Object.assign(base, {
                        display: "grid",
                        placeItems: "center",
                        borderRadius: 999,
                        background: "linear-gradient(135deg,#22a8ff,#4f7bff)",
                        color: "#fff",
                        fontWeight: 700,
                        fontSize: `${o.size}cqw`,
                      });
                    }
                    return (
                      <div
                        key={o.id}
                        className={`cse-obj ${sel === o.id ? "selected" : ""}`}
                        style={base}
                        onPointerDown={(e) => onPointerDown(e, o)}
                      >
                        {o.type === "image" && o.assetUrl ? <img src={o.assetUrl} alt={o.name || ""} /> : o.text}
                      </div>
                    );
                  })}
                </div>
              </div>
              <Card title="What has been done to this design" className="cse-mt">
                <div className="cse-oplog">
                  {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div className="cse-help">Nothing yet — drag something.</div>}
                </div>
              </Card>
            </div>

            <div className="cse-edpanel">
              <div className="cse-seclbl" style={{ margin: 0 }}>Selected</div>
              {selected ? (
                <div className="cse-stack" style={{ gap: 8 }}>
                  <b style={{ fontSize: 13 }}>{selected.name || selected.id}</b>
                  {selected.type === "text" || selected.type === "button" ? (
                    <label className="cse-fld">
                      Words
                      <textarea
                        className="cse-input"
                        rows={2}
                        value={selected.text || ""}
                        onChange={(e) => setDoc({ ...doc, objects: doc.objects.map((o) => (o.id === selected.id ? { ...o, text: e.target.value } : o)) })}
                        onBlur={(e) => applyOps([{ op: "set", target: selected.id, payload: { text: e.target.value }, summary: "changed the words" }])}
                      />
                    </label>
                  ) : null}
                  {selected.size != null ? (
                    <label className="cse-fld">
                      Size
                      <input
                        className="cse-range"
                        type="range"
                        min={1}
                        max={16}
                        step={0.2}
                        value={selected.size}
                        onChange={(e) => setDoc({ ...doc, objects: doc.objects.map((o) => (o.id === selected.id ? { ...o, size: Number(e.target.value) } : o)) })}
                        onMouseUp={(e) => applyOps([{ op: "resize", target: selected.id, payload: { size: Number((e.target as HTMLInputElement).value) }, summary: "changed the size" }])}
                      />
                    </label>
                  ) : null}
                  {selected.color ? (
                    <label className="cse-fld">
                      Colour
                      <input
                        type="color"
                        value={/^#/.test(selected.color) ? selected.color : "#ffffff"}
                        onChange={(e) => applyOps([{ op: "set", target: selected.id, payload: { color: e.target.value }, summary: "changed the colour" }])}
                        style={{ width: "100%", height: 34, border: "1px solid var(--border)", borderRadius: 8, background: "none" }}
                      />
                    </label>
                  ) : null}
                  <div className="cse-row">
                    <span className="cse-help">x {selected.x.toFixed(1)}% · y {selected.y.toFixed(1)}%</span>
                  </div>
                  <button
                    type="button"
                    className="cse-btn sm danger"
                    onClick={() => {
                      setDoc({ ...doc, objects: doc.objects.filter((o) => o.id !== selected.id) });
                      applyOps([{ op: "delete", target: selected.id, payload: {}, summary: `deleted ${selected.name || selected.id}` }]);
                      setSel("");
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : (
                <p className="cse-help">Click something on the canvas.</p>
              )}

              <div className="cse-divider" />
              <Note kind="info">
                <div style={{ fontSize: 12 }}>
                  Ask the Coworker to change this design and it reads the canvas first, then writes against revision {revision}. If you move something in the
                  meantime, its change is refused and it reads again.
                </div>
              </Note>
            </div>
          </div>
        )}
      </div>
    </PermissionGate>
  );
}
