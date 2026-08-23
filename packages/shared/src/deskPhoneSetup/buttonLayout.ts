/**
 * The buttons down the side of a desk phone.
 *
 * Izzy, 2026-08-21: "the agent should set up BLFs and everything for each user on
 * the system. The system should have a BLF, except on its own. Make it also so that
 * the user can put in a custom speed dial for a BLF."
 *
 * So: one button per colleague showing whether they are free or on a call, never a
 * button for the phone's own extension, and whatever keys are left over stay free
 * for the customer's own speed dials.
 *
 * ⛔⛔ THE STORAGE FORMAT IS NOT INVENTED — it was read off a live customer phone.
 * `provisioning.devices.keys` holds
 *   {"dss_keys":{"1":{"tpl_override":"1","type":"16","description":"Leah Fulop",
 *                     "value":"101","extension":"101","line":"1"}, ...}}
 * every field a string, keys numbered from "1". Emit exactly that shape; VitalPBX's
 * generator renders it into `linekey.N.*` and anything else is silently ignored.
 *
 * ⛔⛔ AND THERE IS A LIVE BUG UNDERNEATH THIS. `console_writes.py::save_phone`
 * writes `keys` in its INSERT branch and NOT in its UPDATE branch, so editing a
 * phone blanks every button on it at the next render, with no error anywhere. This
 * module is useless until that is fixed — see `savePhoneWritesKeysOnUpdate` in the
 * helper tests.
 */

import { deviceKindFor } from "./deviceKinds";

/** Yealink DSS key types. */
export const DSS_TYPE = {
  /** Proven on a live customer phone (device 3, A plus center). */
  BLF: "16",
  /** Proven in template 6 on the production PBX. */
  LINE: "15",
  /**
   * ⛔ From Yealink documentation, NOT yet observed on one of our own phones.
   * Speed dials are written only when the customer asks for one, so a wrong value
   * here cannot affect a phone that has none — but confirm on the first real one.
   */
  SPEED_DIAL: "13",
} as const;

export type DssKeyType = (typeof DSS_TYPE)[keyof typeof DSS_TYPE];

export type DssKey = {
  tpl_override: "1";
  type: DssKeyType;
  description: string;
  value: string;
  extension: string;
  line: string;
};

export type DssKeyMap = { dss_keys: Record<string, DssKey> };

/**
 * How many programmable keys each model actually has.
 *
 * ⛔ Read from the header comment inside the vendor's own `template.cfg` on our PBX
 * — "T53W/T54W/T54S/T46G/T46S/T29G/T46U: X ranges from 1 to 27" and so on. Writing
 * a key past a model's range is not an error anywhere; the phone simply drops it,
 * so an over-long layout looks perfect in the database and is missing buttons on the
 * desk.
 */
const YEALINK_KEY_COUNTS: Array<{ models: string[]; keys: number }> = [
  { models: ["T48U", "T57W", "T48G", "T48S"], keys: 29 },
  { models: ["T53W", "T53", "T54W", "T54S", "T46G", "T46S", "T29G", "T46U", "T58A"], keys: 27 },
  { models: ["T52S", "T27P", "T27G", "T43U"], keys: 21 },
  { models: ["T42G", "T42S", "T41P", "T41S", "T41U", "T42U", "T44U", "T44W"], keys: 15 },
  { models: ["T33G", "T34W", "T31G", "T31W", "T30", "T30P"], keys: 4 },
  { models: ["T40P", "T40G", "T23P", "T23G"], keys: 3 },
  { models: ["T21P_E2", "T21PE2", "T21P"], keys: 2 },
];

/**
 * ⛔ A model we do not recognise gets 3, not 0 and not a guess upward. Three is the
 * smallest count any current Yealink desk phone has, so an unknown model gets a
 * layout that is certainly renderable rather than one that might silently lose
 * buttons. Under-filling is invisible; over-filling is a support call.
 */
export const UNKNOWN_MODEL_KEY_COUNT = 3;

export function yealinkKeyCount(model: string | null | undefined): number {
  const m = String(model ?? "").toUpperCase().replace(/[\s_-]/g, "");
  if (!m) return UNKNOWN_MODEL_KEY_COUNT;
  for (const row of YEALINK_KEY_COUNTS) {
    for (const candidate of row.models) {
      if (candidate.replace(/[\s_-]/g, "") === m) return row.keys;
    }
  }
  return UNKNOWN_MODEL_KEY_COUNT;
}

/**
 * ⛔ The T19 has no programmable keys at all — the vendor template says so outright.
 * ⛔ And only a DESK PHONE has side keys at all: an HT box under a desk, a cordless
 * base, a ceiling speaker and a door intercom have no keys to program, so giving
 * them a layout writes rows the device renders as nothing (2026-08-22, when the
 * scope widened to any VoIP device).
 */
export function modelSupportsButtons(model: string | null | undefined): boolean {
  const m = String(model ?? "").toUpperCase().replace(/[\s_-]/g, "");
  if (m === "T19PE2" || m === "T19P" || m === "T19") return false;
  const kind = deviceKindFor(m);
  return kind === "desk_phone" || kind === "unknown";
}

export type Colleague = {
  /** The extension a button watches and dials. */
  extension: string;
  /** What gets printed on the phone's screen beside the key. */
  displayName: string;
};

export type SpeedDial = { label: string; number: string };

export type ButtonLayoutInput = {
  model: string | null | undefined;
  /** The extension this handset itself answers on. It never gets a button. */
  ownExtension: string;
  /** Everyone on the customer's phone system, in any order. */
  colleagues: Colleague[];
  /** The customer's own additions. They take the keys the colleagues did not need. */
  speedDials?: SpeedDial[];
  /** Reserve key 1 for this phone's own line. Default true. */
  reserveOwnLine?: boolean;
};

export type ButtonLayout = {
  keys: DssKeyMap;
  /** Total programmable keys on this model. */
  capacity: number;
  /** Colleagues that got a button. */
  placed: Colleague[];
  /**
   * ⛔ Colleagues that did NOT fit. Never silently dropped: a 10-key phone in a
   * 30-person office is a normal situation, and the screen has to be able to say
   * "the first 9 fit" rather than showing a layout that quietly lost 21 people.
   */
  omitted: Colleague[];
  speedDialsPlaced: SpeedDial[];
  speedDialsOmitted: SpeedDial[];
  /** Keys still free after everything was placed. */
  free: number;
};

/**
 * Build the layout for one handset.
 *
 * ⛔ Deterministic: colleagues are sorted by extension, numerically where both are
 * numeric, so the same input always produces the same layout. A layout that
 * reshuffles between renders means a customer's buttons move under their fingers
 * every time anything is edited.
 */
export function buildButtonLayout(input: ButtonLayoutInput): ButtonLayout {
  const capacity = modelSupportsButtons(input.model) ? yealinkKeyCount(input.model) : 0;
  const reserveOwnLine = input.reserveOwnLine !== false;

  const own = normalizeExt(input.ownExtension);
  const seen = new Set<string>();
  const candidates: Colleague[] = [];
  for (const c of input.colleagues) {
    const ext = normalizeExt(c.extension);
    // ⛔ The phone's own extension never gets a button. Nobody needs a key to call
    // themselves, and on Yealink a BLF pointed at your own line subscribes the phone
    // to its own state, which is at best noise.
    if (!ext || ext === own) continue;
    if (seen.has(ext)) continue;
    seen.add(ext);
    candidates.push({ extension: ext, displayName: (c.displayName || ext).trim() || ext });
  }
  candidates.sort((a, b) => compareExtensions(a.extension, b.extension));

  const dss: Record<string, DssKey> = {};
  let next = 1;

  if (capacity > 0 && reserveOwnLine && own) {
    dss["1"] = {
      tpl_override: "1",
      type: DSS_TYPE.LINE,
      description: own,
      value: "",
      extension: "",
      line: "1",
    };
    next = 2;
  }

  const placed: Colleague[] = [];
  const omitted: Colleague[] = [];
  for (const c of candidates) {
    if (next > capacity) { omitted.push(c); continue; }
    dss[String(next)] = {
      tpl_override: "1",
      type: DSS_TYPE.BLF,
      description: c.displayName,
      value: c.extension,
      extension: c.extension,
      line: "1",
    };
    placed.push(c);
    next += 1;
  }

  const speedDialsPlaced: SpeedDial[] = [];
  const speedDialsOmitted: SpeedDial[] = [];
  for (const sd of input.speedDials ?? []) {
    const number = String(sd.number ?? "").trim();
    if (!number) continue;
    if (next > capacity) { speedDialsOmitted.push(sd); continue; }
    dss[String(next)] = {
      tpl_override: "1",
      type: DSS_TYPE.SPEED_DIAL,
      description: (sd.label || number).trim() || number,
      value: number,
      extension: "",
      line: "1",
    };
    speedDialsPlaced.push(sd);
    next += 1;
  }

  return {
    keys: { dss_keys: dss },
    capacity,
    placed,
    omitted,
    speedDialsPlaced,
    speedDialsOmitted,
    free: Math.max(0, capacity - (next - 1)),
  };
}

/** Exactly the JSON the provisioning row wants — nothing pretty-printed, nothing extra. */
export function serializeButtonLayout(layout: ButtonLayout): string {
  return JSON.stringify(layout.keys);
}

/**
 * ⛔ Read a layout back defensively. Rows in the field were written by the VitalPBX
 * panel, by us, and by hand; `[]` is a real value that appears on live rows and is
 * NOT a key map. Anything unparseable is an empty layout, never a throw — a bad
 * blob must not be able to take down a screen that lists phones.
 */
export function parseButtonLayout(raw: unknown): DssKeyMap {
  if (raw === null || raw === undefined) return { dss_keys: {} };
  let value: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { dss_keys: {} };
    try { value = JSON.parse(trimmed); } catch { return { dss_keys: {} }; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { dss_keys: {} };
  const map = (value as any).dss_keys;
  if (!map || typeof map !== "object" || Array.isArray(map)) return { dss_keys: {} };
  const out: Record<string, DssKey> = {};
  for (const [k, v] of Object.entries(map as Record<string, any>)) {
    if (!/^\d+$/.test(k) || !v || typeof v !== "object") continue;
    out[k] = {
      tpl_override: "1",
      type: String(v.type ?? "") as DssKeyType,
      description: String(v.description ?? ""),
      value: String(v.value ?? ""),
      extension: String(v.extension ?? ""),
      line: String(v.line ?? "1"),
    };
  }
  return { dss_keys: out };
}

/**
 * Trim only. ⛔ Deliberately NOT digits-only: this platform has non-3-digit and
 * could have non-numeric extension identifiers (Relax Tires runs 1002/1003), and a
 * BLF pointed at an identifier that never resolves is inert, while silently dropping
 * a colleague from every layout is a missing button nobody can explain.
 */
function normalizeExt(raw: string | null | undefined): string {
  return String(raw ?? "").trim();
}

function compareExtensions(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  const aNum = /^\d+$/.test(a), bNum = /^\d+$/.test(b);
  if (aNum && bNum) return na - nb;
  if (aNum) return -1;
  if (bNum) return 1;
  return a.localeCompare(b);
}
