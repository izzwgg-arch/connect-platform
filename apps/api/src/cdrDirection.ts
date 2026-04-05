/**
 * CDR direction — single policy implementation lives in @connect/integrations (callDirectionPolicy).
 * This module re-exports for API ingest, admin backfill, and tests.
 */

import { classifyCallDirectionByEvidence, type ConnectCallDirection } from "@connect/integrations";

export type CdrDirection = ConnectCallDirection;

/** Single-dcontext helper (tests + diagnostics). */
export function directionFromDcontext(
  dcontext: string | null | undefined,
  toNumber?: string | null | undefined,
): CdrDirection | null {
  const r = classifyCallDirectionByEvidence({
    dcontexts: dcontext?.trim() ? [dcontext.trim()] : [],
    channelNames: [],
    fromNumber: null,
    toNumber,
  });
  return r === "unknown" ? null : r;
}

const VALID_DIRECTIONS = new Set<string>(["incoming", "outgoing", "internal", "unknown"]);

export type CanonicalDirectionOpts = {
  /** Every distinct AMI Cdr dcontext observed for this linkedid (logical call) */
  dcontexts?: string[];
  channelNames?: string[];
  telephonyDirectionHint?: string | null;
};

/**
 * Authoritative direction for persisting on ConnectCdr.
 * Uses PBX evidence first; falls back to stored telephony direction; then unknown → storedDir.
 */
export function canonicalDirection(
  fromNumber: string | null | undefined,
  toNumber: string | null | undefined,
  storedDir: string,
  dcontext?: string | null | undefined,
  opts?: CanonicalDirectionOpts,
): CdrDirection {
  const dcontexts = [...(opts?.dcontexts ?? [])];
  if (dcontext && dcontext.trim() && !dcontexts.includes(dcontext.trim())) {
    dcontexts.unshift(dcontext.trim());
  }

  const classified = classifyCallDirectionByEvidence({
    dcontexts,
    channelNames: opts?.channelNames ?? [],
    fromNumber,
    toNumber,
    telephonyDirectionHint: opts?.telephonyDirectionHint,
  });

  if (classified !== "unknown") return classified;

  const d = storedDir as CdrDirection;
  return VALID_DIRECTIONS.has(d) ? d : "unknown";
}

export function wouldOverride(
  fromNumber: string | null | undefined,
  toNumber: string | null | undefined,
  storedDir: string,
  dcontext?: string | null | undefined,
  opts?: CanonicalDirectionOpts,
): boolean {
  return canonicalDirection(fromNumber, toNumber, storedDir, dcontext, opts) !== storedDir;
}

/**
 * @deprecated Dashboard and KPI queries use stored `ConnectCdr.direction` only.
 * Kept for ad-hoc SQL diagnostics that still reference the old CASE expression.
 */
export function cdrCanonicalDirectionSql(
  fromCol = '"fromNumber"',
  toCol = '"toNumber"',
  dirCol = "direction",
  _dcontextCol = '"dcontext"',
): string {
  void _dcontextCol;
  return `CASE\n  WHEN ${dirCol} IN ('incoming','outgoing','internal','unknown') THEN ${dirCol}\n  ELSE 'unknown'\nEND`;
}
