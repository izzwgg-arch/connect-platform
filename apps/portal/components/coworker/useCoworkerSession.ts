"use client";
/**
 * The Coworker workspace's brain on the page — ONE hook drives both the bubble
 * popover and the full page, so the two can never behave differently.
 *
 * What it owns: the task (conversation) being shown, its messages, each turn's live
 * activity (polled from the agent while the message request is open), the question
 * the Coworker is waiting on, Stop, files being uploaded, folders and code projects
 * attached to the task, voice capture, the task list, "Everything it did", and the
 * person's Coworker settings (agent-side prefs + the desktop app's own switches).
 *
 * ⛔ A turn is watched by polling, never by trusting the reply alone: the model can
 * run for minutes, a proxy can drop the long request, and a second window (bubble ↔
 * full page) must see the same live steps. If the message request fails with a
 * network error, the hook keeps watching the turn and reloads the reply from the
 * server when the turn reports done.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentError, answerQuestion, attachToTask, closeTask, DEFAULT_PREFS, linkStatus, listTasks, loadMessages, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES,
  readActivity, readLog, readPrefs, savePrefs, sendMessage, stopTurn, transcribeVoice, uploadFile,
  type CoworkerPrefs, type LogEntry, type TaskRow,
} from "./coworkerApi";
import { applyEvents, newTurn, newTurnId, splitAttachmentNote, turnStatus, type TurnView } from "./coworkerModel";
import { cancelOnComputer, coworkerUi, readDesktopState, type AccessProfile, type AttachedFolder, type DesktopCoworkerState, type ToolGroups } from "./coworkerBridge";

export type ChatItem =
  | { kind: "user"; id: string; text: string; attached: string[]; folders: AttachedFolder[] }
  | { kind: "ai"; id: string; turnId: string | null; text: string | null; degraded?: boolean; failed?: boolean };

export type PendingFile = { id: string; name: string; size: number; progress: number; status: "uploading" | "ready" | "error"; attachmentId?: string; error?: string };
export type VoiceState = "idle" | "recording" | "transcribing";

const LAST_TASK_KEY = "cw.lastTask";
const folderKey = (taskId: string | null) => `cw.folders.${taskId ?? "draft"}`;
const POLL_MS = 700;
/** How long a fresh watcher tolerates "not found" before it treats the turn as gone. */
const TURN_OPEN_GRACE_MS = 10_000;
const MAX_RECORDING_MS = 3 * 60 * 1000;

function readFolders(taskId: string | null): AttachedFolder[] {
  try {
    const raw = JSON.parse(localStorage.getItem(folderKey(taskId)) || "[]");
    return Array.isArray(raw) ? raw.filter((f) => f && typeof f.path === "string" && typeof f.name === "string").map((f) => ({ path: f.path, name: f.name, repo: !!f.repo })).slice(0, 20) : [];
  } catch { return []; }
}
function writeFolders(taskId: string | null, folders: AttachedFolder[]) {
  try { localStorage.setItem(folderKey(taskId), JSON.stringify(folders.slice(0, 20))); } catch { /* storage full or blocked */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

export function friendlyError(e: unknown): string {
  if (e instanceof AgentError) {
    if (e.status === 403) return "You're signed out of Loopcom in this window. Sign in again, then retry.";
    if (e.status === 429) return "Too many requests right now. Wait a moment and try again.";
    if (e.code === "file_too_large") return e.message;
    if (e.code === "transcription_unavailable" || e.code === "no_transcription_provider") return "Couldn't turn your voice into text just now. Try again, or type it.";
    if (e.status >= 500) return "The Coworker couldn't answer just now. Try again in a moment.";
    return e.message && e.message !== e.code ? e.message : "That didn't work. Try again.";
  }
  return "Couldn't reach Loopcom. Check the internet connection and try again.";
}

export function useCoworkerSession(opts: { path: string; initialTaskId?: string | null }) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [turns, setTurns] = useState<Record<string, TurnView>>({});
  const [taskId, setTaskId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingTask, setLoadingTask] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [folders, setFolders] = useState<AttachedFolder[]>([]);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [historyVisible, setHistoryVisible] = useState(true);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [prefs, setPrefs] = useState<CoworkerPrefs>(DEFAULT_PREFS);
  const [desktop, setDesktop] = useState<DesktopCoworkerState | null>(null);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [voice, setVoice] = useState<VoiceState>("idle");
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const mounted = useRef(true);
  const pollers = useRef(new Map<string, { stop: boolean }>());
  const replyReceived = useRef(new Set<string>());
  const uploads = useRef(new Map<string, AbortController>());
  const taskIdRef = useRef<string | null>(null);
  const recorder = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean; timer: ReturnType<typeof setInterval>; limit: ReturnType<typeof setTimeout> } | null>(null);
  taskIdRef.current = taskId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const p of pollers.current.values()) p.stop = true;
      for (const a of uploads.current.values()) a.abort();
      const r = recorder.current;
      if (r) { r.cancelled = true; try { r.mr.stop(); } catch { /* gone */ } }
    };
  }, []);

  /* ── settings & link state ── */
  const refreshDesktop = useCallback(async () => {
    const s = await readDesktopState();
    if (mounted.current) setDesktop(s);
    return s;
  }, []);
  const refreshLink = useCallback(async () => {
    try { const s = await linkStatus(); if (mounted.current) setLinked(!!s.connected); } catch { if (mounted.current) setLinked(false); }
  }, []);
  useEffect(() => {
    void readPrefs().then((p) => mounted.current && setPrefs(p)).catch(() => {});
    void refreshDesktop();
    void refreshLink();
    const t = setInterval(() => { void refreshLink(); }, 30_000);
    return () => clearInterval(t);
  }, [refreshDesktop, refreshLink]);

  const updatePrefs = useCallback(async (patch: Partial<CoworkerPrefs>) => {
    setPrefs((p) => ({ ...p, ...patch }));
    try { const saved = await savePrefs(patch); if (mounted.current) setPrefs(saved); return true; }
    catch (e) { if (mounted.current) { setError(friendlyError(e)); void readPrefs().then(setPrefs).catch(() => {}); } return false; }
  }, []);

  const setAccess = useCallback(async (profile: AccessProfile) => {
    const b = coworkerUi();
    if (!b) return { ok: false as const, error: "no_desktop" };
    const r = await b.setAccess(profile);
    await refreshDesktop();
    return r;
  }, [refreshDesktop]);

  const setGroups = useCallback(async (patch: Partial<ToolGroups>) => {
    const b = coworkerUi();
    if (!b) return false;
    const r = await b.setGroups(patch);
    await refreshDesktop();
    return r.ok;
  }, [refreshDesktop]);

  const setBubble = useCallback(async (on: boolean) => {
    const b = coworkerUi();
    if (!b) return false;
    const r = await b.setBubble(on);
    await refreshDesktop();
    return r.ok;
  }, [refreshDesktop]);

  /* ── task list & log ── */
  const loadTaskList = useCallback(async () => {
    try {
      const r = await listTasks();
      if (!mounted.current) return;
      setHistoryVisible(r.visible);
      setTasks(r.tasks);
    } catch { if (mounted.current) setTasks((t) => t ?? []); }
  }, []);
  const loadActivityLog = useCallback(async () => {
    try { const r = await readLog(150); if (mounted.current) setLog(r.entries); } catch { if (mounted.current) setLog((l) => l ?? []); }
  }, []);

  /* ── watching a turn ── */
  const watchTurn = useCallback((turnId: string, onDone?: (view: TurnView) => void) => {
    if (pollers.current.has(turnId)) return;
    const ctl = { stop: false };
    pollers.current.set(turnId, ctl);
    void (async () => {
      let after = 0;
      let doneSeenAt = 0;
      let failures = 0;
      let latest: TurnView | null = null;
      const startedAt = Date.now();
      let sawTurn = false;
      while (!ctl.stop && mounted.current) {
        try {
          const r = await readActivity(turnId, after);
          failures = 0;
          sawTurn = true;
          if (r.events.length) {
            setTurns((prev) => {
              const view = applyEvents(prev[turnId] ?? newTurn(turnId), r.events);
              latest = view;
              return { ...prev, [turnId]: view };
            });
          }
          after = Math.max(after, r.lastSeq);
          if (r.done) {
            if (!doneSeenAt) doneSeenAt = Date.now();
            // Stop once the reply has landed too, or give the reply 20 s after "done".
            if (replyReceived.current.has(turnId) || Date.now() - doneSeenAt > 20_000) break;
          }
        } catch (e) {
          // ⛔ "Not found" means GONE (agent restarted, or expired) only once the turn
          // has been seen. This poll is fired the same instant the message is sent, so
          // for a fresh turn a 404 usually means "not open yet" — the send is still being
          // verified. Giving up here left the person a blank spinner with no steps for
          // the whole task (2026-09-18, every real send). Keep trying briefly.
          if (e instanceof AgentError && e.status === 404 && (sawTurn || Date.now() - startedAt > TURN_OPEN_GRACE_MS)) break;
          if (++failures > 40) break;
        }
        await sleep(doneSeenAt ? 350 : POLL_MS);
      }
      pollers.current.delete(turnId);
      if (latest && onDone && mounted.current) onDone(latest);
    })();
  }, []);

  /* ── opening a task ── */
  const openTask = useCallback(async (id: string | null) => {
    for (const p of pollers.current.values()) p.stop = true;
    setError(null);
    setNotice(null);
    setActiveTurnId(null);
    setPending([]);
    setTurns({});
    if (!id) {
      setTaskId(null);
      setItems([]);
      setFolders(readFolders(null));
      return;
    }
    setLoadingTask(true);
    setTaskId(id);
    setFolders(readFolders(id));
    try {
      const r = await loadMessages(id);
      if (!mounted.current || taskIdRef.current !== id) return;
      const next: ChatItem[] = [];
      for (const m of r.messages) {
        if (m.role === "user") {
          const { text, attached } = splitAttachmentNote(m.content);
          next.push({ kind: "user", id: m.id, text, attached, folders: [] });
        } else if (m.role === "assistant" || m.role === "staff") {
          next.push({ kind: "ai", id: m.id, turnId: null, text: m.content });
        }
      }
      setItems(next);
      try { localStorage.setItem(LAST_TASK_KEY, id); } catch { /* ignore */ }
      // A turn still running in another window (the bubble ↔ the full page)?
      const live = await attachToTask(id).catch(() => ({ turnId: null }));
      if (live.turnId && mounted.current && taskIdRef.current === id) {
        const turnId = live.turnId;
        setTurns((t) => ({ ...t, [turnId]: t[turnId] ?? newTurn(turnId) }));
        setItems((its) => [...its, { kind: "ai", id: `live-${turnId}`, turnId, text: null }]);
        setActiveTurnId(turnId);
        watchTurn(turnId, () => {
          if (!mounted.current || taskIdRef.current !== id) return;
          setActiveTurnId((a) => (a === turnId ? null : a));
          void loadMessages(id).then((m2) => {
            const last = [...m2.messages].reverse().find((x) => x.role === "assistant");
            if (last) setItems((its) => its.map((it) => (it.kind === "ai" && it.turnId === turnId ? { ...it, text: last.content } : it)));
          }).catch(() => {});
        });
      }
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof AgentError && e.status === 404 ? "That task isn't available any more." : friendlyError(e));
        if (e instanceof AgentError && e.status === 404) { setTaskId(null); setItems([]); }
      }
    } finally {
      if (mounted.current) setLoadingTask(false);
    }
  }, [watchTurn]);

  useEffect(() => {
    if (opts.initialTaskId) void openTask(opts.initialTaskId);
    else setFolders(readFolders(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.initialTaskId]);

  const newTask = useCallback(() => {
    const prev = taskIdRef.current;
    void openTask(null);
    writeFolders(null, []);
    setFolders([]);
    try { localStorage.removeItem(LAST_TASK_KEY); } catch { /* ignore */ }
    // A finished conversation is closed so the history reads as separate tasks.
    if (prev && !activeTurnId) void closeTask(prev);
    void loadTaskList();
  }, [openTask, loadTaskList, activeTurnId]);

  /* ── sending ── */
  const uploadsBusy = pending.some((p) => p.status === "uploading");

  const send = useCallback(async (textIn?: string) => {
    const text = (textIn ?? "").trim();
    if (!text || sending || activeTurnId) return false;
    if (uploadsBusy) { setNotice("Wait for your files to finish uploading."); return false; }
    const ready = pending.filter((p) => p.status === "ready" && p.attachmentId);
    const turnId = newTurnId();
    const startedTask = taskIdRef.current;
    const taskFolders = folders;
    setError(null);
    setNotice(null);
    setSending(true);
    setActiveTurnId(turnId);
    setTurns((t) => ({ ...t, [turnId]: newTurn(turnId) }));
    setItems((its) => [
      ...its,
      { kind: "user", id: `u-${turnId}`, text, attached: ready.map((p) => p.name), folders: taskFolders },
      { kind: "ai", id: `a-${turnId}`, turnId, text: null },
    ]);
    setPending((p) => p.filter((x) => x.status === "error"));
    watchTurn(turnId);
    const finishAi = (patch: Partial<Extract<ChatItem, { kind: "ai" }>>) =>
      setItems((its) => its.map((it) => (it.kind === "ai" && it.turnId === turnId ? { ...it, ...patch } : it)));
    try {
      const r = await sendMessage({
        text, turnId, conversationId: startedTask, newTask: !startedTask,
        attachments: ready.map((p) => p.attachmentId!), folders: taskFolders, path: opts.path,
      });
      replyReceived.current.add(turnId);
      if (!mounted.current) return true;
      if (!startedTask && r.conversationId) {
        setTaskId(r.conversationId);
        writeFolders(r.conversationId, taskFolders);
        writeFolders(null, []);
        try { localStorage.setItem(LAST_TASK_KEY, r.conversationId); } catch { /* ignore */ }
      }
      finishAi({ text: r.humanTakeover ? "A person from Loopcom is handling this now — their reply will appear here." : r.reply, degraded: r.degraded });
      if (prefs.notify !== false && (typeof document !== "undefined" && (document.hidden || !document.hasFocus()))) {
        void coworkerUi()?.taskFinished({ title: "Coworker finished", body: (r.reply || "").slice(0, 160), notify: true }).catch(() => {});
      }
      void loadTaskList();
      return true;
    } catch (e) {
      if (!mounted.current) return false;
      // ⛔ The turn may still be running (a proxy dropped the long request). Keep
      // watching; when it reports done, fetch the reply the server stored.
      if (!(e instanceof AgentError) || e.status >= 500) {
        setNotice("Still working — the connection dropped, but the Coworker keeps going. The answer will appear here.");
        const waitFor = async () => {
          for (let i = 0; i < 1200 && mounted.current; i++) {
            const view = await new Promise<TurnView | undefined>((res) => setTurns((t) => { res(t[turnId]); return t; }));
            if (view?.done) {
              const conv = view.conversationId ?? startedTask;
              if (conv) {
                if (!startedTask) { setTaskId(conv); writeFolders(conv, taskFolders); }
                const m = await loadMessages(conv).catch(() => null);
                const last = m ? [...m.messages].reverse().find((x) => x.role === "assistant") : null;
                if (last) { finishAi({ text: last.content }); setNotice(null); replyReceived.current.add(turnId); return; }
              }
              break;
            }
            await sleep(1500);
          }
          finishAi({ text: friendlyError(e), failed: true });
          setNotice(null);
        };
        void waitFor();
      } else {
        replyReceived.current.add(turnId);
        finishAi({ text: friendlyError(e), failed: true });
      }
      return false;
    } finally {
      if (mounted.current) { setSending(false); setActiveTurnId((a) => (a === turnId ? null : a)); }
    }
  }, [sending, activeTurnId, uploadsBusy, pending, folders, opts.path, watchTurn, prefs.notify, loadTaskList]);

  const stop = useCallback(async () => {
    const turnId = activeTurnId;
    cancelOnComputer();
    if (!turnId) return;
    try { await stopTurn(turnId); } catch { /* the turn may already be over */ }
  }, [activeTurnId]);

  const answer = useCallback(async (turnId: string, questionId: string, value: string | null) => {
    try { await answerQuestion(turnId, questionId, value); return true; }
    catch (e) {
      if (e instanceof AgentError && e.status === 409) return true; // answered elsewhere already
      setError(friendlyError(e));
      return false;
    }
  }, []);

  /* ── files ── */
  const addFiles = useCallback((files: File[]) => {
    const room = MAX_ATTACHMENTS - pending.filter((p) => p.status !== "error").length;
    if (room <= 0) { setNotice(`You can attach up to ${MAX_ATTACHMENTS} files to one message.`); return; }
    const take = files.slice(0, room);
    if (files.length > take.length) setNotice(`Only the first ${room} file${room === 1 ? "" : "s"} were attached (up to ${MAX_ATTACHMENTS} per message).`);
    for (const file of take) {
      const id = uid();
      if (file.size > MAX_UPLOAD_BYTES) {
        setPending((p) => [...p, { id, name: file.name, size: file.size, progress: 0, status: "error", error: "Larger than 60 MB" }]);
        continue;
      }
      const ctl = new AbortController();
      uploads.current.set(id, ctl);
      setPending((p) => [...p, { id, name: file.name, size: file.size, progress: 1, status: "uploading" }]);
      void uploadFile(file, (pct) => { if (mounted.current) setPending((p) => p.map((x) => (x.id === id ? { ...x, progress: pct } : x))); }, ctl.signal)
        .then((a) => { if (mounted.current) setPending((p) => p.map((x) => (x.id === id ? { ...x, status: "ready", progress: 100, attachmentId: a.id } : x))); })
        .catch((e) => { if (mounted.current && !ctl.signal.aborted) setPending((p) => p.map((x) => (x.id === id ? { ...x, status: "error", error: friendlyError(e) } : x))); })
        .finally(() => uploads.current.delete(id));
    }
  }, [pending]);

  const removePending = useCallback((id: string) => {
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
    setPending((p) => p.filter((x) => x.id !== id));
  }, []);

  /* ── folders & code projects ── */
  const addFolderToTask = useCallback((f: AttachedFolder) => {
    setFolders((cur) => {
      const next = [f, ...cur.filter((x) => x.path.toLowerCase() !== f.path.toLowerCase())].slice(0, 20);
      writeFolders(taskIdRef.current, next);
      return next;
    });
  }, []);

  const pickFolder = useCallback(async (repo: boolean) => {
    const b = coworkerUi();
    if (!b) return false;
    const r = await b.pickFolder({ repo });
    if (r.ok) { addFolderToTask(r.folder); void refreshDesktop(); return true; }
    if (r.error !== "cancelled") setNotice(r.message || "That folder couldn't be attached.");
    return false;
  }, [addFolderToTask, refreshDesktop]);

  const removeFolder = useCallback((path: string) => {
    setFolders((cur) => {
      const next = cur.filter((x) => x.path !== path);
      writeFolders(taskIdRef.current, next);
      return next;
    });
  }, []);

  /** Drop: folders go to the desktop app (the real path, via its bridge) or, in a browser, are read and uploaded. */
  const handleDrop = useCallback(async (dt: DataTransfer) => {
    const b = coworkerUi();
    const files: File[] = [];
    const walk = async (entry: any, depth: number): Promise<void> => {
      if (files.length >= MAX_ATTACHMENTS || depth > 4 || !entry) return;
      if (entry.isFile) { await new Promise<void>((res) => entry.file((f: File) => { files.push(f); res(); }, () => res())); return; }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch: any[] = await new Promise((res) => reader.readEntries(res, () => res([])));
          if (!batch.length) break;
          for (const child of batch) { if (files.length >= MAX_ATTACHMENTS) break; await walk(child, depth + 1); }
        }
      }
    };
    const list = Array.from(dt.items ?? []);
    let folderNote = false;
    for (const item of list) {
      if (item.kind !== "file") continue;
      const entry = (item as any).webkitGetAsEntry?.();
      const file = item.getAsFile();
      if (entry?.isDirectory) {
        if (b && file) {
          const r = await b.attachDroppedFolder(file);
          if (r.ok) addFolderToTask(r.folder);
          else if (r.error !== "cancelled") setNotice(r.message || "That folder couldn't be attached.");
        } else {
          folderNote = true;
          await walk(entry, 0);
        }
      } else if (file) {
        files.push(file);
      }
    }
    if (!list.length && dt.files?.length) files.push(...Array.from(dt.files));
    if (files.length) addFiles(files);
    if (folderNote) setNotice(`In a browser a dropped folder is uploaded as files (up to ${MAX_ATTACHMENTS}). Open the Loopcom app to attach a whole folder.`);
    void refreshDesktop();
  }, [addFiles, addFolderToTask, refreshDesktop]);

  /* ── voice ── */
  const stopVoice = useCallback(() => {
    const r = recorder.current;
    if (!r) return;
    try { r.mr.stop(); } catch { /* already stopped */ }
  }, []);
  const cancelVoice = useCallback(() => {
    const r = recorder.current;
    if (!r) return;
    r.cancelled = true;
    try { r.mr.stop(); } catch { /* already stopped */ }
    setVoice("idle");
  }, []);

  const startVoice = useCallback(async (onText: (text: string) => void) => {
    if (recorder.current || voice !== "idle") return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 } });
    } catch {
      setError("The microphone isn't available. Allow microphone access for Loopcom, then try again.");
      return;
    }
    const mime = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const rec = { mr, stream, chunks: [] as Blob[], cancelled: false, timer: setInterval(() => setVoiceSeconds((s) => s + 1), 1000), limit: setTimeout(() => { try { mr.stop(); } catch { /* */ } }, MAX_RECORDING_MS) };
    recorder.current = rec;
    setVoiceSeconds(0);
    setVoice("recording");
    mr.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    mr.onstop = async () => {
      clearInterval(rec.timer);
      clearTimeout(rec.limit);
      stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      if (rec.cancelled || !mounted.current) { setVoice("idle"); return; }
      const blob = new Blob(rec.chunks, { type: mr.mimeType || "audio/webm" });
      if (blob.size < 800) { setVoice("idle"); setNotice("That was too short to hear anything — hold on a moment longer."); return; }
      setVoice("transcribing");
      try {
        const r = await transcribeVoice(blob);
        if (mounted.current) onText(r.text);
      } catch (e) {
        if (mounted.current) setError(friendlyError(e));
      } finally {
        if (mounted.current) setVoice("idle");
      }
    };
    mr.start(1000);
  }, [voice]);

  const activeTurn = activeTurnId ? turns[activeTurnId] ?? null : null;
  const status = useMemo(() => {
    if (activeTurnId) {
      const s = turnStatus(activeTurn);
      if (s === "question") return { tone: "busy" as const, text: "Waiting for your answer" };
      if (s === "approval") return { tone: "busy" as const, text: "Waiting for your OK" };
      return { tone: "busy" as const, text: "Working…" };
    }
    if (linked === false && desktop) return { tone: "off" as const, text: "Not connected" };
    return { tone: "ok" as const, text: "Ready" };
  }, [activeTurnId, activeTurn, linked, desktop]);

  // The most recent turn with activity — the full page's inspector shows it even after it finished.
  const focusTurn = useMemo(() => {
    if (activeTurn) return activeTurn;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "ai" && it.turnId && turns[it.turnId]) return turns[it.turnId];
    }
    return null;
  }, [activeTurn, items, turns]);

  return {
    items, turns, taskId, activeTurnId, activeTurn, focusTurn, sending, error, setError, notice, setNotice, loadingTask,
    pending, uploadsBusy, addFiles, removePending,
    folders, pickFolder, removeFolder, handleDrop,
    send, stop, answer, openTask, newTask,
    tasks, historyVisible, loadTaskList, log, loadActivityLog,
    prefs, updatePrefs, desktop, refreshDesktop, setAccess, setGroups, setBubble, linked,
    voice, voiceSeconds, startVoice, stopVoice, cancelVoice,
    status,
  };
}

export type CoworkerSession = ReturnType<typeof useCoworkerSession>;
