/**
 * The Coworker's per-person settings from the full page: how it talks, what it may
 * use (the phone system, email), whether it shows its steps, and the notes the
 * person wants it to always know.
 *
 * ⛔ STORED AS APPEND-ONLY AUDIT ROWS (`AgentAuditLog`, event `coworker.prefs`), newest
 * row wins. No migration: the shared schema file is edited by other sessions all day,
 * and the audit table already carries a tenant, a JSON payload and a tamper hash — so
 * every change to what the Coworker is allowed to touch is also its own audit trail.
 *
 * ⛔ WHAT LIVES HERE vs ON THE COMPUTER. Settings that decide what may run ON THE
 * PERSON'S COMPUTER (Ask first / Full access, files, browser, spreadsheets, code
 * folders) live in the desktop app's own settings and are enforced there, never
 * here — a server row must not be able to loosen the machine. What lives here is
 * what the agent itself controls: its phone-system tools, its reply style, and the
 * notes it is shown.
 */
import type { AuditLog } from "../audit/audit";

export type CoworkerPrefs = {
  memory: string;
  detail: "short" | "detailed";
  phone: boolean;
  email: boolean;
  showSteps: boolean;
  notify: boolean;
  keepHistory: boolean;
  autoSendVoice: boolean;
};

export const DEFAULT_PREFS: CoworkerPrefs = {
  memory: "",
  detail: "short",
  phone: true,
  email: false,
  showSteps: true,
  notify: true,
  keepHistory: true,
  autoSendVoice: false,
};

export const MAX_MEMORY_CHARS = 2000;

/** Strict read of a prefs object from the wire or a stored row. Unknown keys are dropped. */
export function normalizePrefs(raw: unknown, base: CoworkerPrefs = DEFAULT_PREFS): CoworkerPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof CoworkerPrefs) => (typeof r[k] === "boolean" ? (r[k] as boolean) : (base[k] as boolean));
  return {
    memory: typeof r.memory === "string" ? r.memory.replace(/\r\n?/g, "\n").slice(0, MAX_MEMORY_CHARS) : base.memory,
    detail: r.detail === "detailed" || r.detail === "short" ? r.detail : base.detail,
    phone: bool("phone"),
    email: bool("email"),
    showSteps: bool("showSteps"),
    notify: bool("notify"),
    keepHistory: bool("keepHistory"),
    autoSendVoice: bool("autoSendVoice"),
  };
}

type Owner = { tenantId: string; clientUserId: string };

export class CoworkerPrefsStore {
  private cache = new Map<string, { at: number; prefs: CoworkerPrefs }>();
  constructor(private prisma: any, private audit: AuditLog, private now: () => number = () => Date.now(), private ttlMs = 30_000) {}

  private key(o: Owner) { return `${o.tenantId}:${o.clientUserId}`; }

  async get(owner: Owner): Promise<CoworkerPrefs> {
    const k = this.key(owner);
    const hit = this.cache.get(k);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.prefs;
    let prefs = DEFAULT_PREFS;
    try {
      const row = await this.prisma.agentAuditLog.findFirst({
        where: { event: "coworker.prefs", tenantId: owner.tenantId, payload: { path: ["userId"], equals: owner.clientUserId } },
        orderBy: { ts: "desc" },
        select: { payload: true },
      });
      if (row?.payload && typeof row.payload === "object") prefs = normalizePrefs((row.payload as { prefs?: unknown }).prefs);
    } catch {
      // A failed read falls back to the defaults, which are the SAFER choice (email
      // off, phone on as it always was) — never an error in the middle of a chat.
    }
    this.cache.set(k, { at: this.now(), prefs });
    if (this.cache.size > 20_000) this.cache.clear();
    return prefs;
  }

  async set(owner: Owner, patch: unknown): Promise<CoworkerPrefs> {
    const next = normalizePrefs(patch, await this.get(owner));
    const ok = await this.audit.record({ actor: "customer", event: "coworker.prefs", tenantId: owner.tenantId, payload: { userId: owner.clientUserId, prefs: next } });
    if (!ok) throw new Error("prefs_not_saved");
    this.cache.set(this.key(owner), { at: this.now(), prefs: next });
    return next;
  }
}
