"use client";

/**
 * The Workbench IDE — built from the approved mockup.
 * https://claude.ai/code/artifact/cf13e7b7-ebbf-414e-a1a6-f22dee7a2eaa
 *
 * The markup below is the mockup's, structure for structure, wired to real
 * data: the explorer reads the real repo with real git status, the editor
 * reads real files and highlights them, the terminal runs real commands
 * through the server's four gates, the status bar shows the real branch, and
 * the agent dock talks to the real assistant with a real model switcher.
 *
 * ⛔ Every refusal shown here is the SERVER's. This screen never decides what
 * is allowed; it renders the answer. See supportWorkbench.ts for the gates.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { useSpeakText } from "../../../../hooks/useSpeakText";

/** Shown in the play button's tooltip so it is obvious which voice is used. */
const SPEAK_VOICE = "Kristen";
import "./workbenchIde.css";

type Entry = { name: string; path: string; kind: "dir" | "file"; size?: number; git?: "M" | "U" | "D" | "A" | null };
type FileOut = { path: string; text: string; truncated: boolean; bytes: number };
type Caps = {
  available: boolean;
  branch: string | null;
  /** What the container was built from — the honest stand-in for a branch,
   *  because the api image copies source rather than cloning it. */
  deployedCommit: string | null;
  workspaceName: string | null;
  /** What this container can ACTUALLY run. ⛔ Never offer what is not here. */
  allowedBinaries: string[];
  permittedBinaries: string[];
  timeoutMs: number;
  note: string;
};
type RunOut = { command: string; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; ms: number };
type TermLine = { kind: "cmd" | "out" | "err" | "note" | "agent"; text: string };
type Problem = { sev: "e" | "w"; text: string; loc: string };
type ChatMsg = { id: string; role: "you" | "agent" | "tool" | "error"; text: string; model?: string; pending?: boolean };

/**
 * What the SERVER saw when it opened the page — the same facts the agent's
 * `browse` tool gets back.
 *
 * Shown beside the iframe on purpose. The person is looking at pixels the agent
 * cannot see, and the agent is reasoning about a status code and a title the
 * person cannot see; putting both on one screen is what stops the two of you
 * describing different pages to each other.
 */
type PageInfo = {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: number;
  ms: number;
  title: string | null;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ text: string; href: string }>;
  scripts: string[];
  forms: Array<{ action: string; method: string; fields: string[] }>;
  clientRendered: boolean;
  text: string;
};

/** Widths the preview can be pinned to. A support person is usually being told
 *  "it looks wrong on my phone", so the phone width is not a nicety. */
const PREVIEW_WIDTHS: Array<{ id: string; label: string; px: number | null }> = [
  { id: "fit", label: "Fit", px: null },
  { id: "phone", label: "Phone", px: 390 },
  { id: "tablet", label: "Tablet", px: 820 },
  { id: "desktop", label: "Desktop", px: 1280 },
];

const AGENT_BASE = "/agent-api";

function agentToken(): string {
  if (typeof window === "undefined") return "";
  return (
    window.localStorage.getItem("token") ||
    window.localStorage.getItem("cc-token") ||
    window.localStorage.getItem("authToken") ||
    ""
  );
}
async function agentPost<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`${AGENT_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`agent ${path} failed: ${res.status}`);
  return res.json();
}
async function agentGet<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENT_BASE}/${path}`, { headers: { Authorization: `Bearer ${agentToken()}` } });
  if (!res.ok) throw new Error(`agent ${path} failed: ${res.status}`);
  return res.json();
}

function errBody(e: unknown): { error?: string; message?: string; needsConfirm?: boolean } {
  return ((e as { body?: Record<string, unknown> })?.body ?? {}) as any;
}
function errorText(e: unknown): string {
  const b = errBody(e);
  return b.message || (e as Error)?.message || "Something went wrong.";
}

/* ── syntax highlighting ──────────────────────────────────────────────────
   Deliberately small and local: a tokeniser good enough for the languages in
   this repo, with no new dependency. It renders spans, so a file can never
   inject markup — the text is escaped by React, not by us. */
const KEYWORDS = new Set([
  "import","export","from","const","let","var","function","return","if","else","for","while","await","async",
  "class","extends","new","try","catch","finally","throw","typeof","instanceof","in","of","this","super",
  "true","false","null","undefined","type","interface","enum","as","default","case","switch","break","continue",
  "public","private","protected","readonly","static","implements","void","never","any","unknown","string","number","boolean",
]);
type Tok = { t: string; c: string };
function tokenise(line: string, lang: string): Tok[] {
  if (lang === "md" || lang === "txt") return [{ t: line, c: "" }];
  const out: Tok[] = [];
  let i = 0;
  const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
  while (i < line.length) {
    const rest = line.slice(i);
    // comments
    if (rest.startsWith("//") || (lang === "sh" && rest.startsWith("#"))) { out.push({ t: rest, c: "ide-c" }); break; }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      const piece = end === -1 ? rest : rest.slice(0, end + 2);
      out.push({ t: piece, c: "ide-c" }); i += piece.length; continue;
    }
    // strings
    const q = rest[0];
    if (q === '"' || q === "'" || q === "`") {
      let j = 1;
      while (j < rest.length && (rest[j] !== q || rest[j - 1] === "\\")) j++;
      const piece = rest.slice(0, Math.min(j + 1, rest.length));
      out.push({ t: piece, c: "ide-s" }); i += piece.length; continue;
    }
    // numbers
    if (/[0-9]/.test(q) && (i === 0 || !isWord(line[i - 1]))) {
      const m = rest.match(/^[0-9][0-9_.xXa-fA-F]*/);
      if (m) { out.push({ t: m[0], c: "ide-n" }); i += m[0].length; continue; }
    }
    // words
    if (isWord(q)) {
      const m = rest.match(/^[A-Za-z0-9_$]+/)!;
      const w = m[0];
      const after = rest.slice(w.length).match(/^\s*\(/);
      const cls = KEYWORDS.has(w) ? "ide-k" : after ? "ide-f" : /^[A-Z]/.test(w) ? "ide-t" : "ide-o";
      out.push({ t: w, c: cls }); i += w.length; continue;
    }
    out.push({ t: q, c: "ide-o" }); i += 1;
  }
  return out;
}
function langOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "ts";
  if (["css", "scss"].includes(ext)) return "css";
  if (["md", "markdown"].includes(ext)) return "md";
  if (["sh", "bash"].includes(ext)) return "sh";
  if (["json", "yml", "yaml"].includes(ext)) return "json";
  return "txt";
}
function langLabel(path: string | null): string {
  if (!path) return "Plain text";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript React", js: "JavaScript", jsx: "JavaScript React",
    css: "CSS", md: "Markdown", json: "JSON", sh: "Shell Script", yml: "YAML", yaml: "YAML", prisma: "Prisma",
  };
  return map[ext] ?? "Plain text";
}
function fileIconClass(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx"].includes(ext)) return "ide-fts";
  if (["js", "jsx", "json", "mjs", "cjs"].includes(ext)) return "ide-fjs";
  if (["md"].includes(ext)) return "ide-fmd";
  if (["css", "scss"].includes(ext)) return "ide-fcss";
  return "ide-fdir";
}
function fileIconText(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx"].includes(ext)) return "TS";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "JS";
  if (["json"].includes(ext)) return "{}";
  if (["md"].includes(ext)) return "MD";
  if (["css", "scss"].includes(ext)) return "#";
  return "·";
}

const MODELS = [
  { id: "anthropic:claude-opus-5", name: "Claude Opus 5", tag: "DEEPEST", best: true },
  { id: "anthropic:claude-sonnet-5", name: "Claude Sonnet 5", tag: "FAST", best: false },
  { id: "anthropic:claude-fable-5", name: "Claude Fable 5", tag: "NEW", best: false },
  { id: "openai:gpt-5", name: "OpenAI GPT-5", tag: "CHAT", best: false },
];

export default function SupportWorkbench() {
  const [caps, setCaps] = useState<Caps | null>(null);
  const [capsError, setCapsError] = useState("");

  // explorer
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [openEditors, setOpenEditors] = useState<string[]>([]);

  // editor
  const [file, setFile] = useState<FileOut | null>(null);
  const [fileError, setFileError] = useState("");
  const [activeLine, setActiveLine] = useState(1);

  // panel
  const [panelTab, setPanelTab] = useState<"terminal" | "problems" | "output">("terminal");
  const [lines, setLines] = useState<TermLine[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ command: string; reason: string } | null>(null);

  // agent
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [model, setModel] = useState<string>("anthropic:claude-opus-5");
  const [modelOpen, setModelOpen] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);

  // browser — the preview pane
  const [mainView, setMainView] = useState<"editor" | "preview">("editor");
  const [previewUrl, setPreviewUrl] = useState("https://app.loopcom.net/login");
  const [previewLive, setPreviewLive] = useState("");
  const [previewWidth, setPreviewWidth] = useState<string>("fit");
  const [page, setPage] = useState<PageInfo | null>(null);
  const [pageErr, setPageErr] = useState("");
  const [pageBusy, setPageBusy] = useState(false);
  const [browsableHosts, setBrowsableHosts] = useState<string[]>([]);
  const [frameKey, setFrameKey] = useState(0);

  // palette
  const [palette, setPalette] = useState(false);
  const [palQuery, setPalQuery] = useState("");

  const termRef = useRef<HTMLDivElement | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const speech = useSpeakText();

  /* ── load ── */
  useEffect(() => {
    apiGet<Caps>("/admin/support/workbench/capabilities")
      .then(setCaps)
      .catch((e) => setCapsError(errorText(e)));
    // The live model, read from the agent — never assumed.
    agentGet<{ activeChatModel?: { provider: string; model: string } }>("status")
      .then((s) => {
        if (s?.activeChatModel) setModel(`${s.activeChatModel.provider}:${s.activeChatModel.model}`);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    apiGet<{ hosts: string[] }>("/admin/support/workbench/browsable-hosts")
      .then((h) => setBrowsableHosts(h.hosts))
      .catch(() => setBrowsableHosts([]));
  }, []);

  /**
   * Open a page: put it in the iframe AND ask the server to describe it.
   *
   * ⛔ Both halves, always. The iframe is what a person sees; the server read is
   * what the agent sees. Doing only the iframe would leave the agent blind on a
   * screen that looks like it is showing it something.
   *
   * ⛔ The iframe only ever renders because these are OUR OWN pages and nginx
   * sends `X-Frame-Options: SAMEORIGIN`. That is also the reason the address is
   * refused server-side rather than trusted here: a foreign address would not
   * frame anyway, and the server read must never be pointed off Loopcom.
   */
  const openPage = useCallback(async (raw: string) => {
    const url = raw.trim();
    if (!url) return;
    setPageBusy(true);
    setPageErr("");
    try {
      const out = await apiGet<PageInfo>(`/admin/support/workbench/browse?url=${encodeURIComponent(url)}`);
      setPage(out);
      setPreviewLive(out.finalUrl);
      setFrameKey((k) => k + 1);
    } catch (e) {
      setPage(null);
      setPreviewLive("");
      setPageErr(errorText(e));
    } finally {
      setPageBusy(false);
    }
  }, []);

  const openDir = useCallback(async (p: string) => {
    try {
      const out = await apiGet<{ path: string; entries: Entry[] }>(
        `/admin/support/workbench/files?path=${encodeURIComponent(p)}`,
      );
      setDir(out.path);
      setEntries(out.entries);
    } catch (e) {
      setFileError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (caps?.available) void openDir("");
  }, [caps?.available, openDir]);

  async function openFile(p: string) {
    setFileError("");
    try {
      const out = await apiGet<FileOut>(`/admin/support/workbench/file?path=${encodeURIComponent(p)}`);
      setFile(out);
      setActiveLine(1);
      setOpenEditors((o) => (o.includes(p) ? o : [...o, p].slice(-6)));
    } catch (e) {
      setFile(null);
      setFileError(errorText(e));
    }
  }

  /* ── terminal ── */
  function pushLines(...next: TermLine[]) {
    setLines((l) => [...l, ...next].slice(-500));
    window.setTimeout(() => termRef.current?.scrollTo({ top: 9_999_999 }), 20);
  }

  const runCommand = useCallback(
    async (cmd: string, confirmed: boolean) => {
      if (!cmd.trim() || running) return;
      setRunning(true);
      setPendingConfirm(null);
      if (!confirmed) pushLines({ kind: "cmd", text: cmd });
      try {
        const out = await apiPost<RunOut>("/admin/support/workbench/run", { command: cmd, confirmed });
        if (out.stdout) pushLines({ kind: "out", text: out.stdout.replace(/\n$/, "") });
        if (out.stderr) {
          pushLines({ kind: "err", text: out.stderr.replace(/\n$/, "") });
          // Problems is fed by what really failed — never invented.
          const found = out.stderr
            .split("\n")
            .filter((l) => l.trim())
            .slice(0, 20)
            .map((l) => ({ sev: "e" as const, text: l.trim().slice(0, 200), loc: cmd.split(" ")[0] }));
          setProblems(found);
        } else {
          setProblems([]);
        }
        if (!out.stdout && !out.stderr) pushLines({ kind: "note", text: `(no output) — ${out.ms} ms` });
        if (out.truncated) pushLines({ kind: "note", text: "(output was long and has been cut off)" });
        if (out.exitCode !== 0 && out.exitCode !== null) pushLines({ kind: "note", text: `exit code ${out.exitCode}` });
        void openDir(dir); // git letters may have moved
      } catch (e) {
        const b = errBody(e);
        if (b.needsConfirm) {
          setPendingConfirm({ command: cmd, reason: b.message || "This one needs your say-so." });
        } else {
          pushLines({ kind: "err", text: errorText(e) });
        }
      } finally {
        setRunning(false);
      }
    },
    [running, dir, openDir],
  );

  function submitCommand() {
    const cmd = command.trim();
    if (!cmd) return;
    history.current = [cmd, ...history.current].slice(0, 50);
    histIdx.current = -1;
    setCommand("");
    void runCommand(cmd, false);
  }

  /* ── agent ── */
  const pushChat = useCallback((m: ChatMsg) => {
    setChat((c) => [...c, m]);
    window.setTimeout(() => chatRef.current?.scrollTo({ top: 9_999_999 }), 20);
  }, []);

  async function sendAsk() {
    const text = ask.trim();
    if (!text || asking) return;
    setAsking(true);
    setAsk("");
    pushChat({ id: `u${Date.now()}`, role: "you", text });
    const pendingId = `a${Date.now()}`;
    pushChat({ id: pendingId, role: "agent", text: "", pending: true, model: modelName(model) });
    try {
      const res = await agentPost<{ reply: string; model?: string }>("chat/message", {
        text: file ? `${text}\n\n(Working in the support Workbench. Open file: ${file.path})` : text,
        channel: "chat",
      });
      setChat((c) =>
        c.map((m) => (m.id === pendingId ? { ...m, text: res.reply || "(no answer)", pending: false } : m)),
      );
    } catch (e) {
      setChat((c) =>
        c.map((m) =>
          m.id === pendingId
            ? { ...m, role: "error" as const, pending: false, text: `Couldn't reach the assistant. ${errorText(e)}` }
            : m,
        ),
      );
    } finally {
      setAsking(false);
      window.setTimeout(() => chatRef.current?.scrollTo({ top: 9_999_999 }), 20);
    }
  }

  function modelName(id: string): string {
    return MODELS.find((m) => m.id === id)?.name ?? id;
  }

  async function pickModel(id: string) {
    if (modelBusy) return;
    setModelBusy(true);
    try {
      await agentPost("admin/secrets", { key: "chat_model", value: id });
      setModel(id);
      setModelOpen(false);
      pushChat({ id: `n${Date.now()}`, role: "tool", text: `switched to ${modelName(id)}` });
    } catch (e) {
      pushChat({ id: `n${Date.now()}`, role: "error", text: `Couldn't switch model. ${errorText(e)}` });
    } finally {
      setModelBusy(false);
    }
  }

  /* ── command palette ── */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (e.key === "Escape") {
        setPalette(false);
        setModelOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⛔ Only offer commands this container can actually run. A palette entry that
  // answers "git: not found" teaches people the tool is broken.
  const has = useCallback((bin: string) => !!caps?.allowedBinaries.includes(bin), [caps]);
  const paletteItems = useMemo(
    () =>
      [
        { ic: "✦", label: "Agent: switch model…", kbd: "⌘M", need: "", run: () => setModelOpen(true) },
        { ic: "✦", label: "Agent: clear conversation", kbd: "⌘L", need: "", run: () => setChat([]) },
        { ic: "⌸", label: "View: focus terminal", kbd: "⌃`", need: "", run: () => setPanelTab("terminal") },
        { ic: "⚠", label: "View: problems", kbd: "", need: "", run: () => setPanelTab("problems") },
        { ic: "⎇", label: "Git: show working tree changes", kbd: "", need: "git", run: () => void runCommand("git status --short", false) },
        { ic: "▷", label: "Run: services health", kbd: "", need: "docker", run: () => void runCommand("docker ps --format '{{.Names}} {{.Status}}'", false) },
        { ic: "⌸", label: "Run: disk space", kbd: "", need: "df", run: () => void runCommand("df -h", false) },
        { ic: "🗂", label: "Explorer: go to workspace root", kbd: "", need: "", run: () => void openDir("") },
      ].filter((i) => !i.need || has(i.need)),
    [runCommand, openDir, has],
  );
  const palFiltered = paletteItems.filter((i) => i.label.toLowerCase().includes(palQuery.toLowerCase()));

  const crumbs = file ? file.path.split("/") : [];
  const codeLines = file ? file.text.split("\n") : [];
  const lang = file ? langOf(file.path) : "txt";

  if (capsError) return <div className="ide-empty">Couldn&apos;t load the workbench. {capsError}</div>;
  if (caps && !caps.available) return <div className="ide-empty">The workbench isn&apos;t set up on this server.</div>;

  return (
    <div className="ide-root">
      {/* ── menu bar ── */}
      <div className="ide-menubar">
        <span className="ide-traffic"><i /><i /><i /></span>
        {["File", "Edit", "Selection", "View", "Go", "Run", "Terminal", "Help"].map((m) => (
          <button key={m} className="ide-mi" onClick={() => setPalette(true)}>{m}</button>
        ))}
        <span className="ide-title">
          {file ? `${file.path.split("/").pop()} — ` : ""}{caps?.workspaceName ?? "workspace"} — Loopcom Workbench
        </span>
        <span className="ide-mright"><span>⟲</span><span>⇥</span><span>◫</span><span>⚙</span></span>
      </div>

      <div className="ide-body">
        {/* ── activity bar ── */}
        <div className="ide-activity">
          <button className="ide-ai on" title="Explorer">🗂</button>
          <button className="ide-ai" title="Search" onClick={() => setPalette(true)}>🔍</button>
          {/* Source control only when this container actually has git. */}
          {has("git") ? (
            <button className="ide-ai" title="Source control" onClick={() => void runCommand("git status --short", false)}>
              ⎇{entries.some((e) => e.git) ? <span className="ide-badge">{entries.filter((e) => e.git).length}</span> : null}
            </button>
          ) : null}
          <button className="ide-ai" title="Run" onClick={() => setPanelTab("terminal")}>▷</button>
          <button className="ide-ai" title="Problems" onClick={() => setPanelTab("problems")}>⬚</button>
          <button
            className={"ide-ai" + (mainView === "preview" ? " on" : "")}
            title="Preview a page"
            onClick={() => { setMainView("preview"); if (!page && !pageBusy) void openPage(previewUrl); }}
          >
            🌐
          </button>
          <button className="ide-ai" title="Agent">✦</button>
          <span className="ide-ai-sp" />
          <button className="ide-ai" title="Command palette" onClick={() => setPalette(true)}>⚙</button>
        </div>

        {/* ── explorer ── */}
        <div className="ide-side">
          <div className="ide-sbhead"><span>Explorer</span><span>⋯</span></div>
          {openEditors.length ? (
            <div className="ide-sec">
              <div className="ide-sech"><span className="ide-chev">▾</span> OPEN EDITORS</div>
              <div className="ide-tree">
                {openEditors.map((p) => (
                  <button key={p} className={"ide-tr" + (file?.path === p ? " on" : "")} style={{ paddingLeft: 26 }} onClick={() => void openFile(p)}>
                    <span className={"ide-ic " + fileIconClass(p)}>{fileIconText(p)}</span>
                    {p.split("/").pop()}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="ide-sec grow">
            <div className="ide-sech"><span className="ide-chev">▾</span> {(caps?.workspaceName ?? "workspace").toUpperCase()}{dir ? ` / ${dir}` : ""}</div>
            <div className="ide-tree">
              {dir ? (
                <button className="ide-tr" style={{ paddingLeft: 12 }} onClick={() => void openDir(dir.split("/").slice(0, -1).join("/"))}>
                  <span className="ide-ic">↰</span> ..
                </button>
              ) : null}
              {entries.map((e) => (
                <button
                  key={e.path}
                  className={"ide-tr" + (file?.path === e.path ? " on" : "")}
                  style={{ paddingLeft: 12 }}
                  onClick={() => (e.kind === "dir" ? void openDir(e.path) : void openFile(e.path))}
                >
                  <span className={"ide-ic " + (e.kind === "dir" ? "ide-fdir" : fileIconClass(e.name))}>
                    {e.kind === "dir" ? "▸" : fileIconText(e.name)}
                  </span>
                  {e.name}
                  {e.git ? <span className={"ide-g " + (e.git === "U" ? "u" : "m")}>{e.git}</span> : null}
                </button>
              ))}
              {entries.length === 0 ? <div className="ide-empty">Empty.</div> : null}
            </div>
          </div>
        </div>

        {/* ── editor ── */}
        <div className="ide-edcol">
          {/* ── the browser ──────────────────────────────────────────────
              Izzy, 2026-08-24: "even a browser, so the agent can see what
              things look like."

              ⛔ TWO HALVES, AND THEY ARE HONESTLY DIFFERENT. The iframe is
              pixels, and only a PERSON can see it. The strip beneath is what
              the SERVER read — status, timing, title, headings, forms — and
              that is exactly what the agent's `browse` tool receives. Showing
              both together is what stops the person and the agent describing
              different pages to each other.

              ⛔ It does NOT screenshot. Pixels would need a headless browser
              and app-api-1 has no chromium; saying "the agent can see this"
              about the iframe would be a lie the model would then act on. */}
          {mainView === "preview" ? (
            <>
              <div className="ide-tabs">
                <button className="ide-tab on">
                  <span className="ide-ic ide-ic-web">🌐</span>
                  Preview
                  <span className="ide-x" onClick={(ev) => { ev.stopPropagation(); setMainView("editor"); }}>×</span>
                </button>
                <span className="ide-tab ide-fill" />
              </div>

              <div className="ide-addr">
                <button className="ide-abtn" title="Reload" disabled={pageBusy} onClick={() => void openPage(previewUrl)}>⟳</button>
                <input
                  className="ide-url"
                  value={previewUrl}
                  spellCheck={false}
                  onChange={(e) => setPreviewUrl(e.target.value)}
                  onKeyDown={(e) => (e.key === "Enter" ? void openPage(previewUrl) : null)}
                  placeholder="https://app.loopcom.net/login"
                />
                <span className="ide-widths">
                  {PREVIEW_WIDTHS.map((w) => (
                    <button
                      key={w.id}
                      className={"ide-wbtn" + (previewWidth === w.id ? " on" : "")}
                      onClick={() => setPreviewWidth(w.id)}
                    >
                      {w.label}
                    </button>
                  ))}
                </span>
                <button className="ide-abtn" disabled={pageBusy} onClick={() => void openPage(previewUrl)}>Open</button>
              </div>

              <div className="ide-preview">
                {pageErr ? (
                  <div className="ide-empty ide-empty-bad">
                    {pageErr}
                    {browsableHosts.length ? (
                      <div className="ide-hosts">The browser can open: {browsableHosts.join(" · ")}</div>
                    ) : null}
                  </div>
                ) : null}
                {!pageErr && !previewLive ? (
                  <div className="ide-empty">{pageBusy ? "Opening…" : "Type one of Loopcom's own addresses and press Open."}</div>
                ) : null}
                {!pageErr && previewLive ? (
                  <div className="ide-frame-wrap">
                    <iframe
                      key={frameKey}
                      className="ide-frame"
                      src={previewLive}
                      title="Page preview"
                      style={
                        PREVIEW_WIDTHS.find((w) => w.id === previewWidth)?.px
                          ? { width: `${PREVIEW_WIDTHS.find((w) => w.id === previewWidth)!.px}px` }
                          : undefined
                      }
                    />
                  </div>
                ) : null}
              </div>

              {/* What the agent sees of the same page. */}
              {page ? (
                <div className="ide-pagefacts">
                  <div className="ide-pf-row">
                    <span className={"ide-pf-status " + (page.ok ? "ok" : "bad")}>{page.status}</span>
                    <b>{page.title || "(no title)"}</b>
                    <span className="ide-pf-dim">{page.ms} ms · {(page.bytes / 1024).toFixed(0)} KB · {page.contentType.split(";")[0]}</span>
                    <button
                      className="ide-abtn"
                      title="Ask the agent about this page"
                      onClick={() => setAsk(`Look at ${page.finalUrl} and tell me what you find.`)}
                    >
                      Ask the agent about this
                    </button>
                  </div>
                  {page.clientRendered ? (
                    <div className="ide-pf-note">
                      This page fills itself in after loading, so there is almost no text in the markup. That is normal
                      here — it is not evidence of a broken deploy.
                    </div>
                  ) : null}
                  <div className="ide-pf-cols">
                    <div>
                      <h6>Headings</h6>
                      {page.headings.length ? page.headings.slice(0, 8).map((h, i) => (
                        <div key={i} className="ide-pf-item" style={{ paddingLeft: (h.level - 1) * 10 }}>{h.text}</div>
                      )) : <div className="ide-pf-item dim">none</div>}
                    </div>
                    <div>
                      <h6>Forms</h6>
                      {page.forms.length ? page.forms.slice(0, 4).map((f, i) => (
                        <div key={i} className="ide-pf-item">{f.method.toUpperCase()} {f.action || "(this page)"} · {f.fields.join(", ") || "no named fields"}</div>
                      )) : <div className="ide-pf-item dim">none</div>}
                    </div>
                    <div>
                      <h6>Scripts</h6>
                      {page.scripts.length ? page.scripts.slice(0, 5).map((x, i) => (
                        <div key={i} className="ide-pf-item">{x.split("/").pop()}</div>
                      )) : <div className="ide-pf-item dim">none</div>}
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="ide-tabs" style={mainView === "preview" ? { display: "none" } : undefined}>
            {openEditors.length === 0 ? <span className="ide-tab on">Welcome</span> : null}
            {openEditors.map((p) => (
              <button key={p} className={"ide-tab" + (file?.path === p ? " on" : "")} onClick={() => void openFile(p)}>
                <span className={fileIconClass(p)}>{fileIconText(p)}</span>
                {p.split("/").pop()}
                <span className="ide-x" onClick={(ev) => { ev.stopPropagation(); setOpenEditors((o) => o.filter((x) => x !== p)); if (file?.path === p) setFile(null); }}>×</span>
              </button>
            ))}
            <span className="ide-tab ide-fill" />
            <span className="ide-acts"><span>⫿⫿</span><span>⤢</span><span>⋯</span></span>
          </div>

          <div className="ide-crumbs" style={mainView === "preview" ? { display: "none" } : undefined}>
            {crumbs.length === 0 ? <span>no file open</span> : null}
            {crumbs.map((c, i) => (
              <span key={i}>
                {i > 0 ? <span className="s"> › </span> : null}
                {i === crumbs.length - 1 ? <b>{c}</b> : c}
              </span>
            ))}
          </div>

          <div className="ide-edwrap" style={mainView === "preview" ? { display: "none" } : undefined}>
            <div className="ide-code">
              {fileError ? <div className="ide-empty">{fileError}</div> : null}
              {!file && !fileError ? <div className="ide-empty">Pick a file in the explorer to read it.</div> : null}
              {file
                ? codeLines.map((l, i) => (
                    <div
                      key={i}
                      className={"ide-ln" + (activeLine === i + 1 ? " cur" : "")}
                      onClick={() => setActiveLine(i + 1)}
                    >
                      <span className="ide-no">{i + 1}</span>
                      <span className="ide-gut" />
                      {tokenise(l, lang).map((tk, j) => (
                        <span key={j} className={tk.c}>{tk.t}</span>
                      ))}
                    </div>
                  ))
                : null}
              {file?.truncated ? <div className="ide-empty">— file is longer than this; showing the first part —</div> : null}
            </div>
            {file ? (
              <div className="ide-minimap">
                <div className="ide-mmview" />
                {codeLines.slice(0, 60).map((l, i) => (
                  <div key={i} className={"ide-mm" + (l.trim().length > 60 ? " a" : l.trim().length > 20 ? " b" : "")} />
                ))}
              </div>
            ) : null}
          </div>

          {/* ── panel ── */}
          <div className="ide-panel">
            <div className="ide-ptabs">
              <button className={"ide-ptab" + (panelTab === "terminal" ? " on" : "")} onClick={() => setPanelTab("terminal")}>Terminal</button>
              <button className={"ide-ptab" + (panelTab === "problems" ? " on" : "")} onClick={() => setPanelTab("problems")}>
                Problems{problems.length ? <span className="ide-cnt">{problems.length}</span> : null}
              </button>
              <button className={"ide-ptab" + (panelTab === "output" ? " on" : "")} onClick={() => setPanelTab("output")}>Output</button>
              <span className="ide-pacts">
                <span className="ide-sshpill">⇄ {caps?.workspaceName ? "root@loopcom" : "not connected"} <span className="ide-rec" /> recording</span>
                <span>＋</span><span>⌄</span><span>✕</span>
              </span>
            </div>

            {panelTab === "terminal" ? (
              <>
                <div className="ide-shells">
                  <span className="ide-sh on">1: root@loopcom</span>
                  <span className="ide-shnote">read-only commands · every one checked against your ground rules and recorded</span>
                </div>
                <div className="ide-term" ref={termRef}>
                  {lines.length === 0 ? (
                    <div className="dim">
                      Type a command below — try{" "}
                      <span className="pa">{has("docker") ? "docker ps" : has("ls") ? "ls -la" : caps?.allowedBinaries[0] ?? "ls"}</span>.
                    </div>
                  ) : null}
                  {lines.map((l, i) => (
                    <div key={i} className={"ln2 " + (l.kind === "err" ? "errl" : l.kind === "note" ? "dim" : "")}>
                      {l.kind === "cmd" ? <><span className="pr">root@loopcom</span>:<span className="pa">/app</span># </> : null}
                      {l.kind === "agent" ? <span className="pa">✦ agent · </span> : null}
                      {l.text}
                    </div>
                  ))}
                </div>
                {pendingConfirm ? (
                  <div className="ide-confirm">
                    <span>⏸ {pendingConfirm.reason}</span>
                    <button className="b yes" onClick={() => void runCommand(pendingConfirm.command, true)}>Run it anyway</button>
                    <button className="b no" onClick={() => { pushLines({ kind: "note", text: "(skipped)" }); setPendingConfirm(null); }}>Skip</button>
                  </div>
                ) : null}
                <div className="ide-termin">
                  <span className="pr">$</span>
                  <input
                    value={command}
                    placeholder={running ? "running…" : has("docker") ? "docker ps" : "ls -la"}
                    disabled={running}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitCommand();
                      else if (e.key === "ArrowUp") {
                        histIdx.current = Math.min(histIdx.current + 1, history.current.length - 1);
                        if (history.current[histIdx.current]) setCommand(history.current[histIdx.current]);
                      } else if (e.key === "ArrowDown") {
                        histIdx.current = Math.max(histIdx.current - 1, -1);
                        setCommand(histIdx.current >= 0 ? history.current[histIdx.current] : "");
                      }
                    }}
                  />
                </div>
              </>
            ) : null}

            {panelTab === "problems" ? (
              <div className="ide-plist">
                {problems.length === 0 ? <div className="ide-empty">No problems reported.</div> : null}
                {problems.map((p, i) => (
                  <div className="ide-prow" key={i}>
                    <span className={"sev " + p.sev}>{p.sev === "e" ? "⊗" : "⚠"}</span>
                    <span>{p.text}</span>
                    <span className="loc">{p.loc}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {panelTab === "output" ? (
              <div className="ide-term">
                <div className="dim">Workbench · {caps?.note}</div>
                <div className="dim">Available here: {caps?.allowedBinaries.join(" ") || "—"}</div>
                {caps && caps.permittedBinaries.length > caps.allowedBinaries.length ? (
                  <div className="dim">
                    Permitted but not installed in this container:{" "}
                    {caps.permittedBinaries.filter((b) => !caps.allowedBinaries.includes(b)).join(" ")}
                  </div>
                ) : null}
                <div className="dim">Timeout: {Math.round((caps?.timeoutMs ?? 0) / 1000)}s</div>
                {caps?.deployedCommit ? <div className="dim">Running commit: {caps.deployedCommit}</div> : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* ── agent dock ── */}
        <div className="ide-agent">
          <div className="ide-aghead">
            <span style={{ color: "var(--acc)" }}>✦</span><b>Agent</b>
            <span className="sp" />
            <button className="ic" title="Clear" onClick={() => setChat([])}>⟲</button>
          </div>

          <button className="ide-modelbtn" onClick={() => setModelOpen((v) => !v)} disabled={modelBusy}>
            <span className="sw" /><span className="nm">{modelName(model)}</span><span className="cv">▾</span>
          </button>
          {modelOpen ? (
            <div className="ide-modelmenu">
              {MODELS.map((m) => (
                <button key={m.id} className={"ide-mrow" + (model === m.id ? " on" : "")} onClick={() => void pickModel(m.id)}>
                  <span className="tick">{model === m.id ? "✓" : ""}</span>
                  {m.name}
                  <span className={"tag" + (m.best ? " best" : "")}>{m.tag}</span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="ide-chat" ref={chatRef}>
            {chat.length === 0 ? (
              <div className="ide-empty">Ask in plain English — it can read the code and run read-only commands.</div>
            ) : null}
            {chat.map((m) =>
              m.role === "tool" ? (
                <div className="ide-toolchip" key={m.id}><span className="tk">✓</span>{m.text}</div>
              ) : (
                <div
                  key={m.id}
                  className={"ide-msg " + (m.role === "you" ? "ide-m-you" : m.role === "error" ? "ide-m-err" : "ide-m-ag")}
                >
                  <span className="who">
                    {m.role === "you" ? "You · plain English" : m.role === "error" ? "Problem" : `Agent${m.model ? ` · ${m.model}` : ""}`}
                    {/* Read it out. Agent answers only — there is nothing to
                        gain from hearing your own question back, and each play
                        is billed per character. */}
                    {m.role !== "you" && m.role !== "error" && !m.pending && m.text.trim() ? (
                      <button
                        type="button"
                        className={"ide-speak" + (speech.playingId === m.id ? " on" : "")}
                        disabled={speech.loadingId === m.id}
                        aria-label={speech.playingId === m.id ? "Stop reading" : "Read this out loud"}
                        title={speech.playingId === m.id ? "Stop" : `Read out loud (${SPEAK_VOICE})`}
                        onClick={() => void speech.speak(m.id, m.text)}
                      >
                        {speech.loadingId === m.id ? "…" : speech.playingId === m.id ? "■" : "▶"}
                      </button>
                    ) : null}
                  </span>
                  {m.pending ? <span className="ide-think"><i /><i /><i /></span> : m.text}
                </div>
              ),
            )}
          </div>

          {speech.error ? <div className="ide-speakmsg bad">{speech.error}</div> : null}
          {speech.truncated && !speech.error ? (
            <div className="ide-speakmsg note">That answer was long — you heard the first part of it.</div>
          ) : null}

          <div className="ide-composer">
            {file ? (
              <div className="ide-ctx"><span className="ide-cchip">@{file.path.split("/").pop()}</span></div>
            ) : null}
            <div className="ide-cbox">
              <input
                value={ask}
                placeholder="Ask anything, in plain English…"
                disabled={asking}
                onChange={(e) => setAsk(e.target.value)}
                onKeyDown={(e) => (e.key === "Enter" ? void sendAsk() : null)}
              />
              <button className="send" disabled={asking || !ask.trim()} onClick={() => void sendAsk()}>↑</button>
            </div>
          </div>
        </div>
      </div>

      {/* ── status bar ── */}
      <div className="ide-status">
        <span className="ide-si remote">⇄ SSH: loopcom</span>
        {/* ⛔ A branch when there is a repo; otherwise the deployed commit —
            which is what a support person actually needs to know. Never a
            made-up branch name. */}
        <span className="ide-si">
          {caps?.branch ? `⎇ ${caps.branch}` : caps?.deployedCommit ? `⌗ ${caps.deployedCommit}` : "⌗ —"}
        </span>
        <span className="ide-si dim">⊗ {problems.filter((p) => p.sev === "e").length}  ⚠ {problems.filter((p) => p.sev === "w").length}</span>
        <span className="sp" />
        <span className="ide-si dim">Ln {activeLine}</span>
        <span className="ide-si dim">UTF-8</span>
        <span className="ide-si dim">{langLabel(file?.path ?? null)}</span>
        <span className="ide-si">✦ {modelName(model).replace("Claude ", "")}</span>
      </div>

      {/* ── command palette ── */}
      {palette ? (
        <div className="ide-palback" onClick={() => setPalette(false)}>
          <div className="ide-palette" onClick={(e) => e.stopPropagation()}>
            <div className="ide-palinput">
              <span className="car">›</span>
              <input autoFocus value={palQuery} placeholder="Type a command…" onChange={(e) => setPalQuery(e.target.value)} />
            </div>
            {palFiltered.map((it, i) => (
              <button key={i} className={"ide-palrow" + (i === 0 ? " on" : "")} onClick={() => { it.run(); setPalette(false); setPalQuery(""); }}>
                <span className="ic">{it.ic}</span>{it.label}{it.kbd ? <kbd>{it.kbd}</kbd> : null}
              </button>
            ))}
            {palFiltered.length === 0 ? <div className="ide-empty">No matching command.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
