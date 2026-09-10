/**
 * Carrier migration — the pure rules behind /admin/carrier-migration.
 *
 * Izzy, 2026-09-10: *"we are going to start porting out all numbers from
 * voip.ms, not all at once, and start it very slowly with the first two
 * numbers … I want to set up a system where the swaps are going to be with
 * zero downtime for customers on voice and SMS."*
 *
 * ⛔⛔ THE ONE IDEA THIS FILE EXISTS TO ENFORCE: a number is not one switch,
 * it is THREE, on three different clocks, and collapsing them is how a
 * customer loses texting.
 *
 *   1. CALLS COMING IN move by themselves. Main's `default-trunk` routes on
 *      the DIALLED NUMBER, and both carriers' inbound contexts converge there
 *      (`[trk-132-in](+) exten => s` lifts the DID out of SignalWire's To
 *      header and Gotos the same place VoIP.ms does). So nothing has to be
 *      switched at the moment of the port — the ONLY gap is between the number
 *      landing on the SignalWire account and its handlers being pointed at our
 *      trunk. That gap is what `arrivalWatcher.ts` exists to close.
 *   2. TEXTS: inbound also moves by itself — `ingestInboundSmsToChat` looks a
 *      number up by `phoneE164` with NO provider filter, so both carriers can
 *      be live at once and the thread continues. OUTBOUND does not:
 *      SignalWire refuses to send from a local number that is not on an
 *      approved 10DLC campaign, so the campaign must be active BEFORE the
 *      number moves.
 *   3. CALLS GOING OUT are set once per CUSTOMER with one caller ID, on the
 *      PBX. So a customer's numbers move as a block, and the switch is a PBX
 *      change a person makes — this module reports readiness, it never claims
 *      to know the PBX's outbound state, because Connect does not mirror it.
 *
 * Everything here is pure so it can be driven in tests without a database or a
 * carrier. The database and SignalWire live in `routes.ts` / `arrivalWatcher.ts`.
 */

/** Lane carriers. */
export type Carrier = "voipms" | "signalwire";

/**
 * Per-number status.
 *  not_started → nothing decided
 *  ready       → cleared to file (no blockers)
 *  filed       → filed at SignalWire, waiting for the confirmed date
 *  landing     → the confirmed date has arrived; the watcher is looking
 *  live        → on SignalWire and pointed at our trunk
 *  done        → old carrier's side torn down too
 *  held        → deliberately kept back
 */
export type MigrationStatus = "not_started" | "ready" | "filed" | "landing" | "live" | "done" | "held";

export const MIGRATION_STATUSES: MigrationStatus[] = [
  "not_started",
  "ready",
  "filed",
  "landing",
  "live",
  "done",
  "held",
];

/**
 * Numbers the platform itself depends on. Porting one of these breaks Loopcom,
 * not a customer — so the board holds them back by default and says why.
 * ⛔ Never "clean this up" into a plain list: the reason is the whole point.
 */
export const PROTECTED_DIDS: Record<string, string> = {
  // The platform's billing / pay-link / sign-in-code sender.
  "8457231213": "Sends every pay link, receipt and sign-in code on the platform. If its texting breaks, billing breaks.",
  // The agent-escalation + admin shared inbox number.
  "8455577768": "Carries the escalation texts to your phone and the admin shared inbox.",
};

/** Bare 10 digits from anything phone-shaped. Empty string when it is not. */
export function normalizeDid(input: unknown): string {
  const d = String(input ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

/**
 * ⛔ The two number shapes in this codebase differ and always have:
 * `PbxTenantInboundDid.e164` holds bare 10 digits (`8453050012`) while
 * `TenantSmsNumber.phoneE164` and SignalWire hold `+18453050012`. This is the
 * ONE place that converts, so a join can never be written against the wrong one.
 */
export function carrierMigrationE164(did: string): string {
  const d = normalizeDid(did);
  return d ? `+1${d}` : "";
}

/** (845) 305-0012 */
export function formatDid(did: string): string {
  const d = normalizeDid(did);
  return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(did ?? "");
}

// ── Account-level gates ──────────────────────────────────────────────────────

export interface GateState {
  id: "tendlc" | "attestation" | "voice";
  /** ok | pending | blocked */
  level: "ok" | "pending" | "blocked";
  title: string;
  status: string;
  detail: string;
}

export interface GateInput {
  /** Count of TenantSmsRegistration rows in an active state. */
  activeSmsRegistrations: number;
  /** Any 10DLC registration filed at all (brand or campaign in flight). */
  smsRegistrationsInFlight: number;
  /** Numbers on the board that carry texting. */
  textingNumbers: number;
  /** Owner-confirmed: SignalWire has granted A/B attestation on the account. */
  attestationGranted: boolean;
  /** SignalWire credentials resolve and the PBX SIP endpoint is discoverable. */
  voicePathReady: boolean;
  /** Why the voice path is not ready, when it is not. */
  voicePathDetail?: string | null;
}

export function buildGates(input: GateInput): GateState[] {
  const tendlc: GateState =
    input.activeSmsRegistrations > 0
      ? {
          id: "tendlc",
          level: "ok",
          title: "Texting registration (10DLC)",
          status: "Approved",
          detail: `${input.activeSmsRegistrations} registration${input.activeSmsRegistrations === 1 ? "" : "s"} active. Numbers that text can move.`,
        }
      : input.smsRegistrationsInFlight > 0
        ? {
            id: "tendlc",
            level: "pending",
            title: "Texting registration (10DLC)",
            status: "In progress",
            detail: `Filed and waiting on the carriers. Until one is approved, no ported number can send a text. ${input.textingNumbers} of our numbers carry texting.`,
          }
        : {
            id: "tendlc",
            level: "blocked",
            title: "Texting registration (10DLC)",
            status: "Not started",
            detail: `No brand and no campaign exist on SignalWire. Until one is approved, no ported number can send a text. ${input.textingNumbers} of our numbers carry texting.`,
          };

  const attestation: GateState = input.attestationGranted
    ? {
        id: "attestation",
        level: "ok",
        title: "Caller ID trust (attestation)",
        status: "Granted",
        detail: "SignalWire signs our outbound calls at A/B. Customers' outgoing calls can move.",
      }
    : {
        id: "attestation",
        level: "pending",
        title: "Caller ID trust (attestation)",
        status: "Needs you",
        detail:
          "SignalWire signs every outbound call C until they vet the account, and carriers label those calls spam. Incoming calls are unaffected — only outgoing.",
      };

  const voice: GateState = input.voicePathReady
    ? {
        id: "voice",
        level: "ok",
        title: "Voice path",
        status: "Ready",
        detail: "The SignalWire trunk is reachable and the phone system endpoint resolves. Nothing to do per number.",
      }
    : {
        id: "voice",
        level: "blocked",
        title: "Voice path",
        status: "Not ready",
        detail: input.voicePathDetail || "SignalWire is not reachable, so a number that lands could not be pointed at the phone system.",
      };

  return [tendlc, attestation, voice];
}

// ── The board ────────────────────────────────────────────────────────────────

export interface InventoryDid {
  /** Bare 10 digits. */
  did: string;
  connectTenantId: string | null;
  tenantName: string | null;
}

export interface MigrationRowInput {
  did: string;
  status: string;
  holdReason: string | null;
  voiceCarrier: string;
  smsCarrier: string;
  portReference: string | null;
  focDate: Date | string | null;
  filedAt: Date | string | null;
  landedAt: Date | string | null;
  pointedAt: Date | string | null;
  smsFlippedAt: Date | string | null;
  lastError: string | null;
  notes: string | null;
}

export interface SmsNumberInput {
  /** `+1…` form. */
  phoneE164: string;
  provider: string;
  tenantId: string | null;
}

export interface BoardNumber {
  did: string;
  formatted: string;
  e164: string;
  tenantId: string | null;
  tenantName: string;
  status: MigrationStatus;
  /** Plain-English stage line for the board. */
  stage: string;
  voice: Carrier;
  sms: Carrier | "none";
  hasTexting: boolean;
  /** Reasons this number cannot be filed right now. Empty = clear to go. */
  blockers: string[];
  holdReason: string | null;
  protectedReason: string | null;
  portReference: string | null;
  focDate: string | null;
  landedAt: string | null;
  pointedAt: string | null;
  lastError: string | null;
  /** Seconds between the number landing and being pointed at us. */
  claimSeconds: number | null;
}

export interface BoardCustomer {
  tenantId: string | null;
  tenantName: string;
  numbers: BoardNumber[];
  /** Outbound is per customer — this is readiness, never a claim about the PBX. */
  outbound: { level: "ok" | "pending" | "blocked"; label: string; detail: string };
  /** True when every number on this customer carries texting or none do. */
  protectedCount: number;
}

export interface BoardSummary {
  total: number;
  onVoipms: number;
  moving: number;
  onSignalwire: number;
  textingNumbers: number;
  customers: number;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asStatus(v: string): MigrationStatus {
  return (MIGRATION_STATUSES as string[]).includes(v) ? (v as MigrationStatus) : "not_started";
}

function asCarrier(v: string): Carrier {
  return v === "signalwire" ? "signalwire" : "voipms";
}

/**
 * The plain-English stage line. This is what a person reads first, so it says
 * what is true and what is next — never a status code.
 */
export function stageLine(n: {
  status: MigrationStatus;
  blockers: string[];
  holdReason: string | null;
  focDate: string | null;
  voice: Carrier;
}): string {
  if (n.status === "held") return n.holdReason ? `Held back — ${n.holdReason}` : "Held back";
  if (n.status === "done") return "Done — old carrier torn down";
  if (n.status === "live") return "Live on SignalWire";
  if (n.status === "landing") return "Landing today — watching for it";
  if (n.status === "filed") {
    const d = n.focDate ? new Date(n.focDate) : null;
    const when = d && !Number.isNaN(d.getTime())
      ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })
      : "date not set";
    return `Filed — due ${when}`;
  }
  if (n.blockers.length > 0) return `Blocked — ${n.blockers[0]}`;
  return "Ready to file";
}

export interface BuildBoardInput {
  inventory: InventoryDid[];
  migrations: MigrationRowInput[];
  smsNumbers: SmsNumberInput[];
  gates: GateState[];
}

export interface BoardResult {
  summary: BoardSummary;
  customers: BoardCustomer[];
}

export function buildBoard(input: BuildBoardInput): BoardResult {
  const byDid = new Map<string, MigrationRowInput>();
  for (const m of input.migrations) {
    const d = normalizeDid(m.did);
    if (d) byDid.set(d, m);
  }

  const smsByE164 = new Map<string, SmsNumberInput>();
  for (const s of input.smsNumbers) {
    if (s.tenantId) smsByE164.set(String(s.phoneE164 || ""), s);
  }

  const tendlcOk = input.gates.find((g) => g.id === "tendlc")?.level === "ok";
  const attestationOk = input.gates.find((g) => g.id === "attestation")?.level === "ok";
  const voiceOk = input.gates.find((g) => g.id === "voice")?.level === "ok";

  const numbers: BoardNumber[] = [];
  for (const inv of input.inventory) {
    const did = normalizeDid(inv.did);
    if (!did) continue;
    const e164 = carrierMigrationE164(did);
    const row = byDid.get(did);
    const smsRow = smsByE164.get(e164);
    const hasTexting = Boolean(smsRow);

    const status = asStatus(row?.status ?? "not_started");
    const voice = asCarrier(row?.voiceCarrier ?? "voipms");
    const smsCarrier: Carrier | "none" = hasTexting
      ? asCarrier(row?.smsCarrier ?? (smsRow && String(smsRow.provider) === "SIGNALWIRE" ? "signalwire" : "voipms"))
      : "none";

    const protectedReason = PROTECTED_DIDS[did] ?? null;

    // Blockers are only about whether it is safe to FILE now. A number already
    // filed or live has moved past them.
    const blockers: string[] = [];
    if (status === "not_started" || status === "ready") {
      if (protectedReason) blockers.push("this number is one of ours — see the note");
      if (hasTexting && !tendlcOk) blockers.push("texting is not registered on SignalWire");
      if (!voiceOk) blockers.push("the SignalWire voice path is not ready");
    }

    const landedAt = iso(row?.landedAt ?? null);
    const pointedAt = iso(row?.pointedAt ?? null);
    let claimSeconds: number | null = null;
    if (landedAt && pointedAt) {
      const delta = (new Date(pointedAt).getTime() - new Date(landedAt).getTime()) / 1000;
      if (Number.isFinite(delta) && delta >= 0) claimSeconds = Math.round(delta);
    }

    const n: BoardNumber = {
      did,
      formatted: formatDid(did),
      e164,
      tenantId: inv.connectTenantId,
      tenantName: inv.tenantName || "Unassigned",
      status,
      stage: "",
      voice,
      sms: smsCarrier,
      hasTexting,
      blockers,
      holdReason: row?.holdReason ?? null,
      protectedReason,
      portReference: row?.portReference ?? null,
      focDate: iso(row?.focDate ?? null),
      landedAt,
      pointedAt,
      lastError: row?.lastError ?? null,
      claimSeconds,
    };
    n.stage = stageLine(n);
    numbers.push(n);
  }

  // Group by customer. Outbound is a per-customer readiness read, never a
  // claim about what the PBX is actually doing.
  const groups = new Map<string, BoardCustomer>();
  for (const n of numbers) {
    const key = n.tenantId || `unassigned:${n.tenantName}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        tenantId: n.tenantId,
        tenantName: n.tenantName,
        numbers: [],
        outbound: { level: "blocked", label: "", detail: "" },
        protectedCount: 0,
      };
      groups.set(key, g);
    }
    g.numbers.push(n);
    if (n.protectedReason) g.protectedCount += 1;
  }

  for (const g of groups.values()) {
    g.numbers.sort((a, b) => a.did.localeCompare(b.did));
    const moved = g.numbers.filter((n) => n.voice === "signalwire").length;
    const remaining = g.numbers.length - moved;
    if (!attestationOk) {
      g.outbound = {
        level: "blocked",
        label: "Held — caller ID",
        detail:
          "Outgoing calls stay on VoIP.ms until SignalWire vets the account, or every call from this customer gets labelled spam.",
      };
    } else if (remaining > 0) {
      g.outbound = {
        level: "pending",
        label: `Waiting on ${remaining} more`,
        detail:
          "Outgoing is one route with one caller ID for the whole customer, so it moves only once every number on this customer has.",
      };
    } else {
      g.outbound = {
        level: "ok",
        label: "Ready to switch",
        detail: "Every number has moved and caller ID is vetted. The switch itself is a change on the phone system.",
      };
    }
  }

  const customers = [...groups.values()].sort((a, b) => a.tenantName.localeCompare(b.tenantName));

  const summary: BoardSummary = {
    total: numbers.length,
    onVoipms: numbers.filter((n) => n.voice === "voipms").length,
    moving: numbers.filter((n) => n.status === "filed" || n.status === "landing").length,
    onSignalwire: numbers.filter((n) => n.voice === "signalwire").length,
    textingNumbers: numbers.filter((n) => n.hasTexting).length,
    customers: customers.length,
  };

  return { summary, customers };
}

// ── Decisions the watcher and the routes make ────────────────────────────────

export type ClaimDecision = { claim: true } | { claim: false; reason: string };

/**
 * Should the arrival watcher point this number at our trunk?
 *
 * ⛔ FAILS CLOSED, and the closed direction matters: this is the one call that
 * writes to a live carrier's routing. A number appearing on the SignalWire
 * account that nobody filed is IGNORED — we do not own the intent behind it.
 */
export function decideClaim(
  row: { status: string; pointedAt: Date | string | null; holdReason?: string | null },
  seenOnSignalWire: boolean,
): ClaimDecision {
  const status = asStatus(row.status);
  if (status === "held") return { claim: false, reason: "held" };
  if (status !== "filed" && status !== "landing") return { claim: false, reason: "not_awaiting_arrival" };
  if (row.pointedAt) return { claim: false, reason: "already_pointed" };
  if (!seenOnSignalWire) return { claim: false, reason: "not_on_account_yet" };
  return { claim: true };
}

export type SmsSwitchDecision = { switch: true } | { switch: false; reason: string };

/**
 * Should this number's texting move to SignalWire?
 *
 * ⛔ NEVER automatic. `TenantSmsNumber.provider` is a single field that decides
 * BOTH who sends outbound AND whether the VoIP.ms poll still picks the number
 * up — and SignalWire refuses to send from a number that is not on an approved
 * campaign. Flipping it early takes a customer's outbound texting away with no
 * way back until the campaign lands, so it is an explicit action with a gate.
 */
export function decideSmsSwitch(input: {
  hasTexting: boolean;
  voice: Carrier;
  smsCarrier: Carrier | "none";
  tendlcActive: boolean;
}): SmsSwitchDecision {
  if (!input.hasTexting) return { switch: false, reason: "no_texting_on_this_number" };
  if (input.smsCarrier === "signalwire") return { switch: false, reason: "already_on_signalwire" };
  if (input.voice !== "signalwire") return { switch: false, reason: "number_has_not_landed_yet" };
  if (!input.tendlcActive) return { switch: false, reason: "texting_not_registered" };
  return { switch: true };
}

/** Human sentence for a refusal code, so the screen never shows a slug. */
export function explainSmsSwitch(reason: string): string {
  switch (reason) {
    case "no_texting_on_this_number":
      return "This number does not carry texting, so there is nothing to move.";
    case "already_on_signalwire":
      return "Texting on this number is already on SignalWire.";
    case "number_has_not_landed_yet":
      return "The number has not arrived on SignalWire yet — move the calls first.";
    case "texting_not_registered":
      return "SignalWire will not send from this number until the texting registration is approved. Moving it now would take the customer's outgoing texts away.";
    default:
      return "This cannot be moved right now.";
  }
}

/** Human sentence for a claim refusal. */
export function explainClaim(reason: string): string {
  switch (reason) {
    case "held":
      return "This number is being held back on purpose.";
    case "not_awaiting_arrival":
      return "This number has not been filed, so nothing is expected to arrive.";
    case "already_pointed":
      return "This number is already pointed at the phone system.";
    case "not_on_account_yet":
      return "The number has not arrived on the SignalWire account yet.";
    default:
      return "Nothing to do.";
  }
}
