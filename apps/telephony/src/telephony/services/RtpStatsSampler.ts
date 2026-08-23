/**
 * Per-call RTP quality sampling from Asterisk's own counters — the half of the
 * picture no client can see.
 *
 * ⛔ WHY (Izzy 2026-08-23: "monitor every single call … data, data, data"):
 * a phone can only count the packets that ARRIVED. On Hanna's broken highway
 * call her app reported 1.7% loss while the PBX measured **39% on her uplink**
 * (packets that never made it). Asterisk's `pjsip show channelstats` carries
 * both directions per channel; this sampler polls it over the AMI Command
 * action (read-only, the wake-dial-publish precedent) while calls are live and
 * keeps the LAST sample per channel, because the stats vanish with the channel
 * at hangup — sampling "at call end" is structurally impossible.
 *
 * The CdrNotifier attaches the final samples to the CDR ingest payload, so the
 * PBX-side numbers land on `ConnectCdr.rtpStats` next to the app's own
 * quality report — the joined dataset the future codec tuner needs.
 *
 * Design constraints:
 * - ⛔ Polls ONLY while at least one call is active — an idle PBX gets zero
 *   AMI traffic from this.
 * - ⛔ The CLI string is a CONSTANT (AMI Command can run any verb).
 * - ⛔ Channel names in the CLI output are TRUNCATED (~18 chars) — matching
 *   against live calls is prefix-based, and an ambiguous fragment (two live
 *   channels sharing the fragment) is matched to NEITHER rather than guessed.
 * - Fails silent: a parse error or AMI hiccup skips the tick; sampling must
 *   never affect call handling.
 * - Kill switch: RTP_STATS_SAMPLER_DISABLED=1.
 */

import { childLogger } from "../../logging/logger";

const log = childLogger("RtpStatsSampler");

export type RtpChannelStatSample = {
  /** FULL channel name (matched from live calls), e.g. PJSIP/T141_101_1-0000125e */
  channel: string;
  codec: string;
  /** Receive = the remote party's path TO the PBX (a phone's UPLINK). */
  rxCount: number;
  rxLost: number;
  rxLossPct: number;
  rxJitter: number;
  /** Transmit = the PBX's path to the remote party (their downlink). */
  txCount: number;
  txLost: number;
  txLossPct: number;
  txJitter: number;
  rttSec: number;
  uptime: string;
  sampledAt: string; // ISO
};

type ParsedRow = Omit<RtpChannelStatSample, "channel" | "sampledAt"> & {
  /** The TRUNCATED channel fragment as printed by the CLI (no PJSIP/ prefix). */
  channelFragment: string;
};

const UPTIME_RE = /^\d{2}:\d{2}:\d{2}$/;

/**
 * Parse `pjsip show channelstats` output. Real shapes (2026-08-21, live):
 *
 *   ` 4ff028de T141_101_1-0000125 00:02:39 opus 5537 1951 35 0.014 7829 68 0 0.035 0.469`
 *   `          0001-00001267      00:00:15 ulaw  702    0  0 0.000    1  1 100 0.001 0.031`  (no bridge)
 *   ` PJSIP/T8_106-00001266 not valid`                                                      (skip)
 *
 * The BridgeId column can be empty, so rows are told apart by whether the
 * SECOND token is the HH:MM:SS uptime.
 */
export function parseChannelStats(output: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const raw of String(output || "").split("\n")) {
    const line = raw.trim();
    if (!line || /not valid/i.test(line)) continue;
    const t = line.split(/\s+/);
    let frag: string; let rest: string[];
    if (t.length >= 12 && UPTIME_RE.test(t[1] ?? "")) {
      frag = t[0]!; rest = t.slice(1);
    } else if (t.length >= 13 && UPTIME_RE.test(t[2] ?? "")) {
      frag = t[1]!; rest = t.slice(2);
    } else {
      continue; // header / separator / unknown shape
    }
    if (!UPTIME_RE.test(rest[0] ?? "")) continue;
    const nums = rest.slice(2, 11).map(Number);
    if (nums.length < 9 || nums.some((n) => !Number.isFinite(n))) continue;
    rows.push({
      channelFragment: frag,
      uptime: rest[0]!,
      codec: rest[1]!,
      rxCount: nums[0]!, rxLost: nums[1]!, rxLossPct: nums[2]!, rxJitter: nums[3]!,
      txCount: nums[4]!, txLost: nums[5]!, txLossPct: nums[6]!, txJitter: nums[7]!,
      rttSec: nums[8]!,
    });
  }
  return rows;
}

/**
 * Match a truncated CLI fragment to the FULL channel names of live calls.
 * `PJSIP/T141_101_1-0000125e` prints as `T141_101_1-0000125` — i.e. the full
 * name minus the technology prefix, cut at ~18 chars. A fragment matching two
 * or more live channels is matched to NONE (never guess a call's stats).
 */
export function matchFragmentToChannel(fragment: string, liveChannels: readonly string[]): string | null {
  const hits = liveChannels.filter((ch) => {
    const bare = ch.replace(/^[A-Za-z0-9]+\//, "");
    return bare.startsWith(fragment) || ch.startsWith(fragment);
  });
  return hits.length === 1 ? hits[0]! : null;
}

type AmiCommandRunner = {
  command(cli: string, timeoutMs?: number): Promise<{ ok: true; output: string } | { ok: false; error: string }>;
};
type ActiveCallSource = { getActive(): Array<{ channels: string[] }> };

const CHANNELSTATS_CLI = "pjsip show channelstats"; // ⛔ constant, never caller input
const DEFAULT_INTERVAL_MS = 10_000;
const SAMPLE_TTL_MS = 5 * 60_000;

export class RtpStatsSampler {
  private latest = new Map<string, RtpChannelStatSample>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly ami: AmiCommandRunner,
    private readonly calls: ActiveCallSource,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    if (String(process.env.RTP_STATS_SAMPLER_DISABLED ?? "") === "1") {
      log.info("rtp-stats: sampler disabled by env");
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    (this.timer as any)?.unref?.();
    log.info({ intervalMs: this.intervalMs }, "rtp-stats: sampler armed");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // never overlap a slow AMI round-trip
    this.ticking = true;
    try {
      const active = this.calls.getActive();
      if (active.length === 0) { this.prune(); return; }
      const liveChannels = [...new Set(active.flatMap((c) => c.channels || []))];
      if (liveChannels.length === 0) { this.prune(); return; }
      const res = await this.ami.command(CHANNELSTATS_CLI, 4_000).catch(
        (e): { ok: false; error: string } => ({ ok: false, error: String(e?.message || e) }),
      );
      if (!res.ok) return; // silent — sampling must never matter to calls
      const now = new Date().toISOString();
      for (const row of parseChannelStats(res.output)) {
        const full = matchFragmentToChannel(row.channelFragment, liveChannels);
        if (!full) continue;
        const { channelFragment: _drop, ...stat } = row;
        this.latest.set(full, { ...stat, channel: full, sampledAt: now });
      }
      this.prune();
    } catch (e) {
      log.warn({ err: (e as Error)?.message }, "rtp-stats: tick failed (non-fatal)");
    } finally {
      this.ticking = false;
    }
  }

  private prune(): void {
    const cutoff = Date.now() - SAMPLE_TTL_MS;
    for (const [ch, s] of this.latest) {
      if (Date.parse(s.sampledAt) < cutoff) this.latest.delete(ch);
    }
  }

  /** Final samples for a completed call's channels (CdrNotifier attach). */
  statsForChannels(channels: readonly string[] | null | undefined): RtpChannelStatSample[] {
    const out: RtpChannelStatSample[] = [];
    for (const ch of channels || []) {
      const s = this.latest.get(ch);
      if (s) out.push(s);
    }
    return out.slice(0, 12); // bound the payload; a 12-leg call is already exotic
  }
}

// ── Module-scope handle ──────────────────────────────────────────────────────
// CdrNotifier reads the sampler at call end without constructor plumbing
// through every service. Set once at boot in telephony/index.ts.
let _sampler: RtpStatsSampler | null = null;
export function setRtpStatsSampler(s: RtpStatsSampler): void { _sampler = s; }
export function getRtpStatsForChannels(channels: readonly string[] | null | undefined): RtpChannelStatSample[] {
  try {
    return _sampler ? _sampler.statsForChannels(channels) : [];
  } catch {
    return []; // stats are decoration; the CDR must always post
  }
}
