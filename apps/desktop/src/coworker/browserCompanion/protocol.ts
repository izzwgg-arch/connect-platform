/** Versioned, mutually authenticated transport. Browser content has no authority here. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PROTOCOL = 1;
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PORT = 39174;
export type Packet = { version: number; nonce: string; time: number; body: string; mac: string };
export const nonce = () => randomBytes(24).toString("hex");
export function sign(secret: string, direction: string, body: unknown, requestNonce = nonce(), now = Date.now()): Packet {
  const p = { version: PROTOCOL, nonce: requestNonce, time: now, body: JSON.stringify(body), mac: "" };
  p.mac = createHmac("sha256", secret).update(`${direction}\n${p.version}\n${p.nonce}\n${p.time}\n${p.body}`).digest("hex");
  return p;
}
export function verify(secret: string, direction: string, p: unknown, now = Date.now()): p is Packet {
  if (!p || typeof p !== "object") return false;
  const x = p as Packet;
  if (Object.keys(x).sort().join() !== "body,mac,nonce,time,version" || x.version !== PROTOCOL ||
      !/^[a-f0-9]{48}$/.test(x.nonce) || !/^[a-f0-9]{64}$/.test(x.mac) ||
      !Number.isSafeInteger(x.time) || Math.abs(now - x.time) > 30_000 || typeof x.body !== "string" ||
      Buffer.byteLength(x.body) > MAX_MESSAGE_BYTES) return false;
  const expected = createHmac("sha256", secret).update(`${direction}\n${x.version}\n${x.nonce}\n${x.time}\n${x.body}`).digest("hex");
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(x.mac, "hex"));
}
export function safeUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 4096) throw Error("invalid_url");
  const u = new URL(input);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw Error("unsafe_url");
  return u.href;
}
export const COMMANDS = ["tabs", "open", "read", "act", "download", "upload", "screenshot", "wait", "close"] as const;
export type CommandName = typeof COMMANDS[number];
export type BrowserCommand = { id: string; taskId: string; scopeId: string; command: CommandName; args: Record<string, unknown>; expires: number; phase: "prepare" | "execute"; authorization?: string };

/** Reject unknown fields rather than silently forwarding arbitrary browser capabilities. */
export function validateArgs(command: CommandName, args: Record<string, unknown>): void {
  const fields: Record<CommandName, string[]> = {
    tabs: [], open: ["url"], read: ["tabId", "query", "offset", "limit"],
    act: ["tabId", "action", "ref", "value", "checked", "x", "y"], download: ["tabId", "ref"],
    upload: ["tabId", "ref", "path"], screenshot: ["tabId"], wait: ["tabId", "text", "timeoutMs"], close: ["tabId"],
  };
  if (!Object.hasOwn(fields, command) || !args || Array.isArray(args) || typeof args !== "object") throw Error("invalid_command");
  for (const [k, v] of Object.entries(args)) {
    if (!fields[command].includes(k)) throw Error(`unexpected_field:${k}`);
    if (typeof v === "string" && v.length > 8192) throw Error(`field_too_long:${k}`);
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw Error(`invalid_field:${k}`);
    if (["url", "query", "action", "ref", "value", "path", "text"].includes(k) && typeof v !== "string") throw Error(`invalid_string:${k}`);
    if (k === "checked" && typeof v !== "boolean") throw Error("invalid_boolean:checked");
    if (["tabId", "offset", "limit", "timeoutMs", "x", "y"].includes(k) && !Number.isSafeInteger(v)) throw Error(`invalid_number:${k}`);
  }
  if (command !== "tabs" && command !== "open" && (!Number.isSafeInteger(args.tabId) || Number(args.tabId) < 1)) throw Error("tab_id_required");
  if (command === "open") safeUrl(args.url);
  const range = (key: string, min: number, max: number) => { if (args[key] !== undefined && (Number(args[key]) < min || Number(args[key]) > max)) throw Error(`out_of_range:${key}`); };
  range("tabId", 1, 2147483647); range("offset", 0, 1000000); range("limit", 1, 200); range("timeoutMs", 1, 30000); range("x", -2000, 2000); range("y", -2000, 2000);
  if (typeof args.query === "string" && args.query.length > 200) throw Error("query_too_long");
  if (command === "act") {
    if (!["click", "fill", "select", "check", "scroll", "hover", "focus", "submit"].includes(String(args.action))) throw Error("invalid_action");
    const actionFields: Record<string, string[]> = {click:["ref"],fill:["ref","value"],select:["ref","value"],check:["ref","checked"],scroll:["x","y"],hover:["ref"],focus:["ref"],submit:["ref"]};
    for (const key of Object.keys(args)) if (!["tabId","action",...actionFields[String(args.action)]].includes(key)) throw Error(`unexpected_action_field:${key}`);
    if (["fill","select"].includes(String(args.action)) && typeof args.value !== "string") throw Error("value_required");
    if (args.action === "check" && typeof args.checked !== "boolean") throw Error("checked_required");
    if (args.action === "scroll" && args.x === undefined && args.y === undefined) throw Error("scroll_delta_required");
  }
  if (["upload", "download"].includes(command) || (command === "act" && args.action !== "scroll")) {
    if (typeof args.ref !== "string" || !args.ref.trim() || args.ref.length > 120) throw Error("element_ref_required");
  }
  if (command === "upload" && (typeof args.path !== "string" || !args.path.trim() || args.path.includes("\0"))) throw Error("file_required");
  if (command === "wait" && (typeof args.text !== "string" || !args.text.trim() || args.text.length > 2000)) throw Error("wait_text_required");
}
