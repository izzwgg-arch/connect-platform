/**
 * Read every sign-up at once and say where people get stuck.
 *
 * One timeline tells you what happened to one customer; this tells you what to
 * fix. Run against the real data on 2026-08-24 it immediately produced three
 * findings that were true and that nobody could see before:
 *
 *   - "Your number" takes a median of 398 seconds. Every other step is 3-58s.
 *     It is ten times harder than the rest of the wizard put together.
 *   - 15 of the 21 number searches ever run came back empty — 718 six times,
 *     646 four, 917 three, 347 and 415 once each. Every New York area code a
 *     customer asked for was sold out.
 *   - The most common thing that stopped anyone was "Please pick a number from
 *     the list." (5×), which is the same defect seen from the other side.
 *
 * ⛔ Median, not mean. With 23 sign-ups one abandoned tab left open overnight
 * would drag a mean into nonsense and invent a problem that isn't there.
 */

export type PatternEvent = { message: string | null; createdAt?: Date | string };

export type StepTiming = {
  step: string;
  samples: number;
  medianSeconds: number;
  maxSeconds: number;
};

export type BlockerCount = { step: string; message: string; count: number };

export type SearchCount = { query: string; count: number; emptyCount: number };

export type JourneyPatterns = {
  stepTimings: StepTiming[];
  blockers: BlockerCount[];
  searches: SearchCount[];
  searchTotal: number;
  searchEmptyTotal: number;
  backTracks: { from: string; to: string; count: number }[];
  submissionsConsidered: number;
};

const RE_REACHED = /^Reached "(.+?)" after (\d+)s on "(.+?)"$/;
const RE_BLOCKED = /^Stuck on "(.+?)" — the wizard said: (.+)$/;
const RE_SEARCH = /^Searched numbers for "(.+?)" — (.+)$/;
const RE_BACK = /^Went BACK to "(.+?)" from "(.+?)"$/;

function median(values: number[]): number {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

function foundNothing(result: string): boolean {
  return /^0 results?\b/.test(result) || /the search FAILED/i.test(result);
}

export function buildJourneyPatterns(events: PatternEvent[], submissionsConsidered = 0): JourneyPatterns {
  const times = new Map<string, number[]>();
  const blockers = new Map<string, { step: string; message: string; count: number }>();
  const searches = new Map<string, { query: string; count: number; emptyCount: number }>();
  const backs = new Map<string, { from: string; to: string; count: number }>();
  let searchTotal = 0;
  let searchEmptyTotal = 0;

  for (const e of events) {
    const msg = String(e.message ?? "");
    let m: RegExpMatchArray | null;

    if ((m = msg.match(RE_REACHED))) {
      const [, , secs, fromStep] = m;
      const list = times.get(fromStep) ?? [];
      list.push(Number(secs));
      times.set(fromStep, list);
      continue;
    }

    if ((m = msg.match(RE_BLOCKED))) {
      const [, step, message] = m;
      const key = JSON.stringify([step, message]);
      const row = blockers.get(key) ?? { step, message, count: 0 };
      row.count++;
      blockers.set(key, row);
      continue;
    }

    if ((m = msg.match(RE_SEARCH))) {
      const [, query, result] = m;
      const row = searches.get(query) ?? { query, count: 0, emptyCount: 0 };
      row.count++;
      searchTotal++;
      if (foundNothing(result)) {
        row.emptyCount++;
        searchEmptyTotal++;
      }
      searches.set(query, row);
      continue;
    }

    if ((m = msg.match(RE_BACK))) {
      const [, to, from] = m;
      const key = JSON.stringify([from, to]);
      const row = backs.get(key) ?? { from, to, count: 0 };
      row.count++;
      backs.set(key, row);
    }
  }

  const stepTimings: StepTiming[] = [...times.entries()]
    .map(([step, values]) => ({
      step,
      samples: values.length,
      medianSeconds: median(values),
      maxSeconds: Math.max(...values),
    }))
    .sort((a, b) => a.medianSeconds - b.medianSeconds);

  return {
    stepTimings,
    blockers: [...blockers.values()].sort((a, b) => b.count - a.count),
    searches: [...searches.values()].sort((a, b) => b.count - a.count || b.emptyCount - a.emptyCount),
    searchTotal,
    searchEmptyTotal,
    backTracks: [...backs.values()].sort((a, b) => b.count - a.count),
    submissionsConsidered,
  };
}
