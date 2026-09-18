"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, mediaUrl, newIdempotencyKey } from "@/lib/api";
import { Icon, useToast } from "@/components/ui";
import "./media.css";

/** Matches api's StoredAsset, plus the alt text this component tracks locally. */
export type UploadedAsset = {
  id: string;
  kind: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  status: string;
  isPrivate: boolean;
  variants: Record<string, string> | null;
  originalName: string | null;
  alt?: string;
};

type Kind = "image" | "video" | "document" | "audio";
type PendingFile = { key: string; file: File; previewUrl?: string; done: boolean; error?: string; asset?: UploadedAsset; alt: string };

const ACCEPT: Record<Kind, string> = { image: "image/*", video: "video/*", audio: "audio/*", document: "application/pdf" };

/**
 * Reusable upload control: drag-and-drop or click-to-pick, previews while
 * uploading, per-image alt text, remove (deletes the stored asset too).
 * Every accepted file goes straight to `POST /media`; `onChange` fires with
 * the current list of successfully uploaded assets after every change.
 */
export function Uploader({
  accept = "image",
  multiple = true,
  isPrivate = false,
  maxFiles = 10,
  onChange,
  testId = "uploader",
}: {
  accept?: Kind | Kind[];
  multiple?: boolean;
  isPrivate?: boolean;
  maxFiles?: number;
  onChange: (assets: UploadedAsset[]) => void;
  testId?: string;
}) {
  const toast = useToast();
  const [items, setItems] = useState<PendingFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const kinds = Array.isArray(accept) ? accept : [accept];
  const acceptAttr = kinds.map((k) => ACCEPT[k]).join(",");

  useEffect(
    () => () => {
      items.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const emit = useCallback(
    (list: PendingFile[]) => onChange(list.filter((i) => i.asset).map((i) => ({ ...i.asset!, alt: i.alt }))),
    [onChange],
  );

  async function addFiles(files: FileList | File[]) {
    const room = Math.max(0, maxFiles - items.length);
    const list = Array.from(files).slice(0, room);
    if (!list.length) return;
    const started: PendingFile[] = list.map((f) => ({
      key: `${f.name}-${f.size}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file: f,
      previewUrl: f.type.startsWith("image/") || f.type.startsWith("video/") ? URL.createObjectURL(f) : undefined,
      done: false,
      alt: "",
    }));
    setItems((cur) => [...cur, ...started]);
    for (const pf of started) {
      try {
        const form = new FormData();
        form.append("file", pf.file, pf.file.name);
        if (isPrivate) form.append("private", "1");
        form.append("kind", kinds.join(","));
        const res = await api<{ asset: UploadedAsset }>("/media", { method: "POST", form, idempotencyKey: newIdempotencyKey() });
        setItems((cur) => {
          const next = cur.map((x) => (x.key === pf.key ? { ...x, done: true, asset: res.asset } : x));
          emit(next);
          return next;
        });
      } catch (err) {
        setItems((cur) => cur.map((x) => (x.key === pf.key ? { ...x, done: true, error: (err as Error).message } : x)));
        toast((err as Error).message, { kind: "err" });
      }
    }
  }

  async function remove(key: string) {
    const pf = items.find((i) => i.key === key);
    if (pf?.previewUrl) URL.revokeObjectURL(pf.previewUrl);
    setItems((cur) => {
      const next = cur.filter((x) => x.key !== key);
      emit(next);
      return next;
    });
    if (pf?.asset) {
      try {
        await api(`/media/${pf.asset.id}`, { method: "DELETE" });
      } catch {
        /* already gone, or will be swept later */
      }
    }
  }

  function setAlt(key: string, alt: string) {
    setItems((cur) => {
      const next = cur.map((x) => (x.key === key ? { ...x, alt } : x));
      emit(next);
      return next;
    });
  }

  return (
    <div>
      <div
        className={`uploader-drop ${dragOver ? "over" : ""}`}
        role="button"
        tabIndex={0}
        data-testid={`${testId}-dropzone`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
      >
        <Icon name="up" />
        <div>Drag files here, or click to choose</div>
        <small>{kinds.join(", ")} · up to {maxFiles} file{maxFiles === 1 ? "" : "s"}</small>
        <input
          ref={inputRef}
          type="file"
          accept={acceptAttr}
          multiple={multiple}
          hidden
          data-testid={`${testId}-input`}
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {items.length ? (
        <div className="uploader-grid" data-testid={`${testId}-grid`}>
          {items.map((it) => (
            <div key={it.key}>
              <div className="uploader-item">
                {it.asset?.kind === "image" || (!it.asset && it.file.type.startsWith("image/")) ? (
                  <img src={it.asset ? mediaUrl(it.asset.id, "thumb")! : it.previewUrl} alt="" />
                ) : it.asset?.kind === "video" || (!it.asset && it.file.type.startsWith("video/")) ? (
                  <video src={it.asset ? mediaUrl(it.asset.id, "original")! : it.previewUrl} muted />
                ) : (
                  <div className="doc">
                    <Icon name="doc" />
                    {it.file.name}
                  </div>
                )}
                {!it.done ? (
                  <div className="busy">
                    <Icon name="refresh" />
                  </div>
                ) : null}
                {it.error ? <div className="err">{it.error}</div> : null}
                <button type="button" className="rm" aria-label={`Remove ${it.file.name}`} onClick={() => void remove(it.key)} data-testid={`${testId}-remove`}>
                  <Icon name="x" />
                </button>
              </div>
              {it.asset?.kind === "image" ? (
                <input
                  className="uploader-alt"
                  placeholder="Alt text (optional)"
                  value={it.alt}
                  onChange={(e) => setAlt(it.key, e.target.value)}
                  aria-label={`Alt text for ${it.file.name}`}
                  data-testid={`${testId}-alt`}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
