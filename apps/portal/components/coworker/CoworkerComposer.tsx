"use client";
/**
 * The Coworker's composer: type or talk, attach files (any type), folders and code
 * projects, drag and drop onto it, switch between "Ask first" and "Full access", and
 * Send — which becomes Stop while the Coworker works.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, Check, File as FileIcon, Folder, FolderPlus, GitBranch, Loader2, Mic, Paperclip, ShieldCheck, Square, X, Zap } from "lucide-react";
import type { CoworkerSession } from "./useCoworkerSession";
import { accessLabel, coworkerUi, type AccessProfile } from "./coworkerBridge";
import { MAX_ATTACHMENTS } from "./coworkerApi";

export const COMPOSER_PHRASES = [
  "Tell Coworker what to do…", "Add a file", "Add files", "Any kind of file, up to 60 MB each", "Attach a folder",
  "Use a folder on this computer", "Use a code project", "A folder with git version history", "Uploads the files in it",
  "Open the Loopcom app to use a code project", "Asks before changes", "Full access", "Only asks for big things",
  "Ask first", "Asks before it saves, moves, runs or sends anything", "Stops asking for routine work; still asks before deleting, sending or signing in",
  "Change this in the Loopcom app on your computer", "Speak", "Stop recording", "Transcribing…", "Listening", "Send", "Stop",
  "Drop files or folders to attach", "Files are uploaded; folders are attached from this computer", "Remove", "Cancel",
  "Coworker can make mistakes. It always asks before deleting or sending anything.", "Uploading", "Couldn't upload",
] as string[];

export function CoworkerComposer({ s, t, compact }: { s: CoworkerSession; t: (x: string) => string; compact?: boolean }) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<null | "attach" | "access">(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const desktop = !!coworkerUi();
  const profile = s.desktop?.profile ?? null;
  const running = !!s.activeTurnId;

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement)?.closest?.(".cw-menu, [data-cw-menu-toggle]")) setMenu(null); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [menu]);

  const submit = async () => {
    if (running) { await s.stop(); return; }
    const value = text.trim();
    if (!value) return;
    const ok = await s.send(value);
    if (ok !== false) setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };

  const onVoice = () => {
    if (s.voice === "recording") { s.stopVoice(); return; }
    if (s.voice === "transcribing") return;
    void s.startVoice((heard) => {
      if (s.prefs.autoSendVoice && !running) { void s.send(heard); return; }
      setText((cur) => (cur ? `${cur.trimEnd()} ${heard}` : heard));
      setTimeout(() => area.current?.focus(), 0);
    });
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDragging(true); };
  const onDragOver = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; };
  const onDragLeave = (e: DragEvent) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); };
  const onDrop = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current = 0; setDragging(false); void s.handleDrop(e.dataTransfer); };

  const chooseAccess = async (p: AccessProfile) => {
    setMenu(null);
    const r = await s.setAccess(p);
    if (!r.ok && r.error !== "cancelled" && r.error !== "no_desktop") s.setNotice(t("That didn't work. Try again."));
  };

  const accessChip = (
    <button
      type="button"
      data-cw-menu-toggle
      className={`cw-chip button${profile === "AUTONOMOUS" ? " full" : ""}`}
      onClick={() => setMenu(menu === "access" ? null : "access")}
      title={desktop ? t(accessLabel(profile)) : t("Change this in the Loopcom app on your computer")}
      aria-haspopup="menu"
      aria-expanded={menu === "access"}
    >
      {profile === "AUTONOMOUS" ? <Zap size={12} /> : <ShieldCheck size={12} />}
      {t(accessLabel(profile))}
    </button>
  );

  return (
    <div className="cw-composer" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dragging && (
        <div className="cw-dropzone">
          <div>{t("Drop files or folders to attach")}<small>{t("Files are uploaded; folders are attached from this computer")}</small></div>
        </div>
      )}

      {menu === "attach" && (
        <div className="cw-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenu(null); fileInput.current?.click(); }}>
            <Paperclip size={15} /><div>{t("Add files")}<small>{t("Any kind of file, up to 60 MB each")}</small></div>
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); if (desktop) void s.pickFolder(false); else folderInput.current?.click(); }}>
            <FolderPlus size={15} /><div>{t("Attach a folder")}<small>{desktop ? t("Use a folder on this computer") : t("Uploads the files in it")}</small></div>
          </button>
          <button type="button" role="menuitem" disabled={!desktop} onClick={() => { setMenu(null); void s.pickFolder(true); }} title={desktop ? undefined : t("Open the Loopcom app to use a code project")}>
            <GitBranch size={15} /><div>{t("Use a code project")}<small>{desktop ? t("A folder with git version history") : t("Open the Loopcom app to use a code project")}</small></div>
          </button>
        </div>
      )}

      {menu === "access" && (
        <div className="cw-menu" role="menu">
          <button type="button" role="menuitemradio" aria-checked={profile !== "AUTONOMOUS"} className={profile === "SAFE" || !profile ? "on" : ""} disabled={!desktop} onClick={() => void chooseAccess("SAFE")}>
            <ShieldCheck size={15} /><div>{t("Ask first")}<small>{t("Asks before it saves, moves, runs or sends anything")}</small></div>
            {(profile === "SAFE" || !profile) && <Check size={14} />}
          </button>
          <button type="button" role="menuitemradio" aria-checked={profile === "AUTONOMOUS"} className={profile === "AUTONOMOUS" ? "on" : ""} disabled={!desktop} onClick={() => void chooseAccess("AUTONOMOUS")}>
            <Zap size={15} /><div>{t("Full access")}<small>{t("Stops asking for routine work; still asks before deleting, sending or signing in")}</small></div>
            {profile === "AUTONOMOUS" && <Check size={14} />}
          </button>
          {!desktop && <div className="cw-notice">{t("Change this in the Loopcom app on your computer")}</div>}
        </div>
      )}

      <div className={`cw-cbox${dragging ? " drop" : ""}`}>
        {(s.pending.length > 0 || s.folders.length > 0) && (
          <div className="cw-pending">
            {s.folders.map((f) => (
              <span key={f.path} className={`cw-pchip ${f.repo ? "repo" : "folder"}`} title={f.path}>
                {f.repo ? <GitBranch size={13} /> : <Folder size={13} />}
                <span>{f.name}</span>
                <button type="button" aria-label={`${t("Remove")} ${f.name}`} onClick={() => s.removeFolder(f.path)}><X size={12} /></button>
              </span>
            ))}
            {s.pending.map((p) => (
              <span key={p.id} className={`cw-pchip${p.status === "error" ? " err" : ""}`} title={p.error ? `${p.name}: ${p.error}` : p.name}>
                {p.status === "uploading" ? <Loader2 size={13} className="cw-spinning" /> : <FileIcon size={13} />}
                <span>{p.name}</span>
                <button type="button" aria-label={`${t("Remove")} ${p.name}`} onClick={() => s.removePending(p.id)}><X size={12} /></button>
                {p.status === "uploading" && <i className="cw-bar" style={{ width: `${p.progress}%` }} />}
              </span>
            ))}
          </div>
        )}
        {s.voice === "recording" ? (
          <div className="cw-rec" aria-live="polite"><i />{t("Listening")} · {Math.floor(s.voiceSeconds / 60)}:{String(s.voiceSeconds % 60).padStart(2, "0")}
            <button type="button" className="cw-btn" style={{ marginLeft: "auto" }} onClick={s.cancelVoice}>{t("Cancel")}</button>
          </div>
        ) : s.voice === "transcribing" ? (
          <div className="cw-rec" style={{ color: "var(--cw-muted)" }} aria-live="polite"><span className="cw-spin" />{t("Transcribing…")}</div>
        ) : null}
        <textarea
          ref={area}
          rows={compact ? 2 : 2}
          value={text}
          placeholder={t("Tell Coworker what to do…")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => { const files = Array.from(e.clipboardData?.files ?? []); if (files.length) { e.preventDefault(); s.addFiles(files); } }}
          aria-label={t("Tell Coworker what to do…")}
          maxLength={8000}
        />
        <div className="cw-cbar">
          <button type="button" className="cw-icon-btn" data-cw-menu-toggle title={t("Add a file")} aria-label={t("Add a file")} aria-haspopup="menu" aria-expanded={menu === "attach"} onClick={() => setMenu(menu === "attach" ? null : "attach")}>
            <Paperclip size={16} />
          </button>
          <button type="button" className={`cw-icon-btn cw-mic${s.voice === "recording" ? " on" : ""}`} title={s.voice === "recording" ? t("Stop recording") : t("Speak")} aria-label={s.voice === "recording" ? t("Stop recording") : t("Speak")} onClick={onVoice} disabled={s.voice === "transcribing"}>
            <Mic size={16} />
          </button>
          {accessChip}
          <button
            type="button"
            className={`cw-send${running ? " stop" : ""}`}
            aria-label={running ? t("Stop") : t("Send")}
            title={running ? t("Stop") : t("Send")}
            disabled={!running && (!text.trim() || s.sending || s.uploadsBusy)}
            onClick={() => void submit()}
          >
            {running ? <Square size={14} fill="currentColor" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      {!compact && <div className="cw-cnote">{t("Coworker can make mistakes. It always asks before deleting or sending anything.")}</div>}

      <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ""; if (f.length) s.addFiles(f.slice(0, MAX_ATTACHMENTS)); }} />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ""; if (f.length) s.addFiles(f); }}
      />
    </div>
  );
}
