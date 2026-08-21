"use client";

/**
 * The Workbench — Phase 5c of the support console.
 *
 * An IDE shell: the file explorer on the left, the file you are reading in the
 * middle, and the terminal underneath. Every command goes through the Ground
 * Rules and the Watchman on the server; this screen only ever renders the
 * answer, and says plainly what it cannot do.
 *
 * ⛔ Deliberately NOT a shell. The server allows a read-only command list, so
 * the UI states that up front rather than letting someone type `rm` and meet a
 * refusal — a tool that looks like a terminal but silently isn't reads as
 * broken, not as safe.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../../../../services/apiClient";

type Entry = { name: string; path: string; kind: "dir" | "file"; size?: number };
type FileOut = { path: string; text: string; truncated: boolean; bytes: number };
type Caps = { available: boolean; allowedBinaries: string[]; timeoutMs: number; note: string };
type RunOut = {
  ok?: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  ms: number;
};
type Line = { kind: "cmd" | "out" | "err" | "note"; text: string };

function errBody(e: unknown): { error?: string; message?: string; needsConfirm?: boolean } {
  return ((e as { body?: Record<string, unknown> })?.body ?? {}) as any;
}
function errorText(e: unknown): string {
  const b = errBody(e);
  return b.message || (e as Error)?.message || "Something went wrong.";
}

export default function SupportWorkbench() {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [crumbs, setCrumbs] = useState<string[]>([]);
  const [file, setFile] = useState<FileOut | null>(null);
  const [fileError, setFileError] = useState("");
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { kind: "note", text: "Read-only commands only. Type one and press Enter." },
  ]);
  const [running, setRunning] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ command: string; reason: string } | null>(null);
  const termRef = useRef<HTMLDivElement | null>(null);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);

  useEffect(() => {
    apiGet<Caps>("/admin/support/workbench/capabilities").then(setCaps).catch(() => setCaps(null));
  }, []);

  const openDir = useCallback(async (p: string) => {
    try {
      const out = await apiGet<{ path: string; entries: Entry[] }>(
        `/admin/support/workbench/files?path=${encodeURIComponent(p)}`,
      );
      setDir(out.path);
      setEntries(out.entries);
      setCrumbs(out.path ? out.path.split("/") : []);
    } catch (e) {
      setFileError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void openDir("");
  }, [openDir]);

  async function openFile(p: string) {
    setFileError("");
    try {
      setFile(await apiGet<FileOut>(`/admin/support/workbench/file?path=${encodeURIComponent(p)}`));
    } catch (e) {
      setFile(null);
      setFileError(errorText(e));
    }
  }

  function push(...next: Line[]) {
    setLines((l) => [...l, ...next].slice(-400));
    window.setTimeout(() => termRef.current?.scrollTo({ top: 9_999_999 }), 20);
  }

  const run = useCallback(async (cmd: string, confirmed: boolean) => {
    if (!cmd.trim() || running) return;
    setRunning(true);
    setPendingConfirm(null);
    if (!confirmed) push({ kind: "cmd", text: cmd });
    try {
      const out = await apiPost<RunOut>("/admin/support/workbench/run", { command: cmd, confirmed });
      if (out.stdout) push({ kind: "out", text: out.stdout.replace(/\n$/, "") });
      if (out.stderr) push({ kind: "err", text: out.stderr.replace(/\n$/, "") });
      if (!out.stdout && !out.stderr) push({ kind: "note", text: `(no output) — finished in ${out.ms} ms` });
      if (out.truncated) push({ kind: "note", text: "(output was long and has been cut off)" });
      if (out.exitCode !== 0 && out.exitCode !== null) push({ kind: "note", text: `exit code ${out.exitCode}` });
    } catch (e) {
      const b = errBody(e);
      if (b.needsConfirm) {
        setPendingConfirm({ command: cmd, reason: b.message || "This one needs your say-so." });
        push({ kind: "note", text: `⏸ ${b.message ?? "Needs your confirmation."}` });
      } else {
        push({ kind: "err", text: errorText(e) });
      }
    } finally {
      setRunning(false);
    }
  }, [running]);

  function submit() {
    const cmd = command.trim();
    if (!cmd) return;
    history.current = [cmd, ...history.current].slice(0, 50);
    histIdx.current = -1;
    setCommand("");
    void run(cmd, false);
  }

  if (caps && !caps.available) {
    return <div className="sd-state">The workbench isn&apos;t set up on this server.</div>;
  }

  return (
    <div className="sd-wb">
      <aside className="sd-wb-explorer">
        <div className="sd-wb-crumbs">
          <button className="sd-crumb" onClick={() => void openDir("")}>workspace</button>
          {crumbs.map((c, i) => (
            <button key={i} className="sd-crumb" onClick={() => void openDir(crumbs.slice(0, i + 1).join("/"))}>
              /{c}
            </button>
          ))}
        </div>
        <div className="sd-wb-tree">
          {dir ? (
            <button className="sd-wb-item" onClick={() => void openDir(crumbs.slice(0, -1).join("/"))}>
              <span className="sd-wb-ic">↰</span> ..
            </button>
          ) : null}
          {entries.map((e) => (
            <button
              key={e.path}
              className={"sd-wb-item" + (file?.path === e.path ? " on" : "")}
              onClick={() => (e.kind === "dir" ? void openDir(e.path) : void openFile(e.path))}
            >
              <span className="sd-wb-ic">{e.kind === "dir" ? "▸" : "·"}</span>
              {e.name}
            </button>
          ))}
          {entries.length === 0 ? <div className="sd-state">Empty.</div> : null}
        </div>
      </aside>

      <main className="sd-wb-main">
        <div className="sd-wb-editor">
          {fileError ? <div className="sd-banner sd-banner-bad">{fileError}</div> : null}
          {file ? (
            <>
              <div className="sd-wb-filehead">
                <b>{file.path}</b>
                <span className="sd-dim">{file.bytes.toLocaleString()} bytes{file.truncated ? " · showing the first part" : ""}</span>
              </div>
              <pre className="sd-wb-code">
                {file.text.split("\n").map((l, i) => (
                  <span key={i} className="sd-wb-line">
                    <span className="sd-wb-no">{i + 1}</span>
                    {l}
                  </span>
                ))}
              </pre>
            </>
          ) : !fileError ? (
            <div className="sd-state">Pick a file to read it.</div>
          ) : null}
        </div>

        <div className="sd-wb-term">
          <div className="sd-wb-termhead">
            <b>Terminal</b>
            <span className="sd-dim">{caps?.note ?? "Read-only commands only."}</span>
          </div>
          <div className="sd-wb-out" ref={termRef}>
            {lines.map((l, i) => (
              <div key={i} className={"sd-wb-l sd-wb-" + l.kind}>
                {l.kind === "cmd" ? <span className="sd-wb-prompt">$ </span> : null}
                {l.text}
              </div>
            ))}
          </div>
          {pendingConfirm ? (
            <div className="sd-wb-confirm">
              <span>{pendingConfirm.reason}</span>
              <button className="sd-btn sd-btn-primary" disabled={running} onClick={() => void run(pendingConfirm.command, true)}>
                Run it anyway
              </button>
              <button className="sd-btn" onClick={() => { push({ kind: "note", text: "(skipped)" }); setPendingConfirm(null); }}>
                Skip
              </button>
            </div>
          ) : null}
          <div className="sd-composer">
            <input
              value={command}
              placeholder="git status"
              disabled={running}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                else if (e.key === "ArrowUp") {
                  histIdx.current = Math.min(histIdx.current + 1, history.current.length - 1);
                  if (history.current[histIdx.current]) setCommand(history.current[histIdx.current]);
                } else if (e.key === "ArrowDown") {
                  histIdx.current = Math.max(histIdx.current - 1, -1);
                  setCommand(histIdx.current >= 0 ? history.current[histIdx.current] : "");
                }
              }}
            />
            <button className="sd-btn sd-btn-primary" disabled={running || !command.trim()} onClick={submit}>
              {running ? "Running…" : "Run"}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
