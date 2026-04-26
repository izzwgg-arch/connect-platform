import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import type Database from "better-sqlite3";
import { countQueued, isDeployService, openQueueDb, resetStaleRunning, DEPLOY_SERVICES, type JobRow } from "./db.js";
import { startWorkerLoop } from "./worker.js";

function timingSafeEqualString(a: string, b: string): boolean {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function readTail(filePath: string, maxBytes: number): string | null {
  try {
    const st = fs.statSync(filePath);
    const start = st.size > maxBytes ? st.size - maxBytes : 0;
    const len = st.size - start;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Last `maxLines` lines without reading unbounded large files whole. */
function readLastLines(filePath: string, maxLines: number): string[] {
  const st = fs.statSync(filePath);
  const approxBytes = Math.min(st.size, Math.max(64_000, maxLines * 400));
  const start = Math.max(0, st.size - approxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString("utf8").split(/\r?\n/);
    return lines.length <= maxLines ? lines : lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveAllowedLogPath(db: Database.Database, jobId: string, logDir: string): string | null {
  const row = db.prepare(`SELECT log_path FROM jobs WHERE id = ?`).get(jobId) as { log_path: string | null } | undefined;
  if (!row?.log_path) return null;
  const resolved = path.resolve(row.log_path);
  const base = path.resolve(logDir);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

function readWorkerLockState(stateDir: string): {
  present: boolean;
  pid: number | null;
  pidAlive: boolean | null;
  raw: string | null;
} {
  const lockPath = path.join(stateDir, "worker.lock");
  if (!fs.existsSync(lockPath)) {
    return { present: false, pid: null, pidAlive: null, raw: null };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8").trim();
  } catch {
    return { present: true, pid: null, pidAlive: null, raw: null };
  }
  const first = raw.split("\n")[0]?.trim() ?? "";
  const pid = /^\d+$/.test(first) ? Number(first) : null;
  let pidAlive: boolean | null = null;
  if (pid != null && pid > 0) {
    try {
      process.kill(pid, 0);
      pidAlive = true;
    } catch {
      pidAlive = false;
    }
  }
  return { present: true, pid, pidAlive, raw };
}

function readQueueVersion(repoRoot: string): { packageVersion: string; repoHead: string | null } {
  let packageVersion = "unknown";
  try {
    const pj = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "ops", "deploy-queue", "package.json"), "utf8"),
    ) as { version?: string };
    if (pj.version) packageVersion = pj.version;
  } catch {
    /* noop */
  }
  let repoHead: string | null = null;
  try {
    repoHead = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    /* noop */
  }
  return { packageVersion, repoHead };
}

export type CreateAppOptions = {
  db: Database.Database;
  token: string;
  logDir: string;
  repoRoot: string;
  stateDir: string;
  maxQueued: number;
  queueVersion: string;
  repoHead: string | null;
};

export function createApp(opts: CreateAppOptions) {
  const { db, token, logDir, repoRoot, stateDir, maxQueued, queueVersion, repoHead } = opts;
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const want = (token || "").trim();
    if (!want) {
      res.status(503).json({ error: "deploy_queue_token_not_configured" });
      return;
    }
    const hdr =
      String(req.headers["x-deploy-queue-token"] || "").trim() ||
      (String(req.headers.authorization || "").startsWith("Bearer ")
        ? String(req.headers.authorization).slice(7).trim()
        : "");
    if (!hdr || !timingSafeEqualString(hdr, want)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.use(auth);

  app.get("/ops/deploy/status", (_req, res) => {
    const queued = countQueued(db);
    const runningCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'running'`).get() as { c: number }
    ).c;
    const running = db
      .prepare(
        `SELECT id, service, branch, commit_hash, requested_by, status, dry_run,
                created_at, started_at, finished_at, log_path, error_message
         FROM jobs WHERE status = 'running' LIMIT 1`,
      )
      .get() as JobRow | undefined;
    const lock = readWorkerLockState(stateDir);
    res.json({
      queuedCount: queued,
      runningCount,
      maxQueued,
      runningJob: running ?? null,
      targets: DEPLOY_SERVICES,
      lock,
      version: {
        deployQueuePackage: queueVersion,
        repoHead,
      },
    });
  });

  app.get("/ops/deploy/jobs", (req, res) => {
    const status = String(req.query.status || "").trim();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    let sql = `SELECT id, service, branch, commit_hash, requested_by, status, dry_run,
                      created_at, started_at, finished_at, log_path, error_message
               FROM jobs`;
    const args: string[] = [];
    if (status && /^[a-z-]+$/.test(status)) {
      sql += ` WHERE status = ?`;
      args.push(status);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    args.push(String(limit));
    const rows = db.prepare(sql).all(...args) as JobRow[];
    res.json({ jobs: rows });
  });

  app.get("/ops/deploy/jobs/:id", (req, res) => {
    const row = db
      .prepare(
        `SELECT id, service, branch, commit_hash, requested_by, status, dry_run,
                created_at, started_at, finished_at, log_path, error_message
         FROM jobs WHERE id = ?`,
      )
      .get(req.params.id) as JobRow | undefined;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    let logTail: string | null = null;
    if (row.log_path && fs.existsSync(row.log_path)) {
      logTail = readTail(row.log_path, 64_000);
    }
    res.json({ job: row, logTail });
  });

  app.get("/ops/deploy/jobs/:id/log", (req, res) => {
    const lines = Math.min(2000, Math.max(1, Number(req.query.lines) || 200));
    const allowed = resolveAllowedLogPath(db, req.params.id, logDir);
    if (!allowed) {
      res.status(404).json({ error: "log_not_available", detail: "Unknown job or log not yet created / path invalid." });
      return;
    }
    try {
      const arr = readLastLines(allowed, lines);
      res.json({ id: req.params.id, lines: arr.length, text: arr.join("\n") });
    } catch {
      res.status(500).json({ error: "log_read_failed" });
    }
  });

  app.post("/ops/deploy/enqueue", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const service = String(body.service || "").trim();
    const branch = String(body.branch || "").trim();
    const commitHash = body.commitHash != null ? String(body.commitHash).trim() : "";
    const requestedBy = String(body.requestedBy || "unknown").trim().slice(0, 200);
    const dryRun = body.dryRun === true || body.dryRun === "true" || body.dryRun === 1;

    if (!isDeployService(service)) {
      res.status(400).json({ error: "invalid_service", allowed: DEPLOY_SERVICES });
      return;
    }

    if (service === "full-stack") {
      if (!branch || branch.length > 200) {
        res.status(400).json({
          error: "tag_required",
          detail: "For service `full-stack`, set `branch` to the git tag (e.g. v2.1.65) passed to scripts/release/deploy-tag.sh.",
        });
        return;
      }
    } else if (!branch || branch.length > 200) {
      res.status(400).json({ error: "branch_required" });
      return;
    }

    const q = countQueued(db);
    if (q >= maxQueued) {
      res.status(429).json({
        error: "queue_full",
        maxQueued,
        currentQueued: q,
        detail: "Too many queued jobs. Wait for the worker or cancel jobs.",
      });
      return;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const dryInt = dryRun ? 1 : 0;
    try {
      db.prepare(
        `INSERT INTO jobs (id, service, branch, commit_hash, requested_by, status, created_at, started_at, finished_at, log_path, error_message, dry_run)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL, ?)`,
      ).run(
        id,
        service,
        branch,
        commitHash || null,
        requestedBy || "unknown",
        now,
        dryInt,
      );
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        res.status(409).json({
          error: "duplicate_active_job_for_service",
          detail: "A queued or running job already exists for this target.",
        });
        return;
      }
      throw e;
    }
    const job = db
      .prepare(
        `SELECT id, service, branch, commit_hash, requested_by, status, dry_run,
                created_at, started_at, finished_at, log_path, error_message
         FROM jobs WHERE id = ?`,
      )
      .get(id) as JobRow;
    res.status(201).json({ job });
  });

  app.post("/ops/deploy/jobs/:id/cancel", (req, res) => {
    const info = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(req.params.id) as
      | { status: string }
      | undefined;
    if (!info) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (info.status !== "queued") {
      res.status(409).json({ error: "not_cancellable", status: info.status });
      return;
    }
    db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ?, error_message = 'cancelled' WHERE id = ?`).run(
      Date.now(),
      req.params.id,
    );
    res.json({ ok: true, id: req.params.id });
  });

  return app;
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}

async function main() {
  const token = envStr("DEPLOY_QUEUE_TOKEN", "");
  if (!token) {
    console.error("DEPLOY_QUEUE_TOKEN is required");
    process.exit(2);
  }

  const repoRoot = envStr("DEPLOY_REPO_ROOT", "/opt/connectcomms/app");
  const stateDir = envStr("DEPLOY_QUEUE_STATE_DIR", path.join(repoRoot, "ops", "deploy-queue", "var"));
  const sqlitePath = envStr("DEPLOY_QUEUE_SQLITE_PATH", path.join(stateDir, "queue.db"));
  const logDir = envStr("DEPLOY_QUEUE_LOG_DIR", "/var/log/connect-deploys");
  const host = envStr("DEPLOY_QUEUE_BIND", "127.0.0.1");
  const port = Number(envStr("DEPLOY_QUEUE_PORT", "3910")) || 3910;
  const pollMs = Number(envStr("DEPLOY_QUEUE_POLL_MS", "3000")) || 3000;
  const maxQueued = Math.min(500, Math.max(1, Number(envStr("DEPLOY_QUEUE_MAX_QUEUED", "10")) || 10));

  const db = openQueueDb(sqlitePath);
  resetStaleRunning(db, "worker restarted while job was running (marked failed)");

  const { packageVersion, repoHead } = readQueueVersion(repoRoot);

  const stopWorker = startWorkerLoop({ db, repoRoot, logDir, stateDir, pollMs });
  const app = createApp({
    db,
    token,
    logDir,
    repoRoot,
    stateDir,
    maxQueued,
    queueVersion: packageVersion,
    repoHead,
  });
  const server = app.listen(port, host, () => {
    console.log(`[deploy-queue] listening http://${host}:${port} (repo=${repoRoot}) maxQueued=${maxQueued}`);
  });

  const shutdown = () => {
    stopWorker();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
