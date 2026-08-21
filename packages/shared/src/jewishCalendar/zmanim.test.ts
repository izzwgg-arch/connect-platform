import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sunset, sunrise, candleLighting, nightfall, degreesAfterSunset,
  NIGHTFALL_SHITOS, DEFAULT_NIGHTFALL_SHITA, DEFAULT_CANDLE_LIGHTING_MINUTES,
} from "./zmanim";

const TZ = "America/New_York";
const MONSEY: [number, number] = [41.1112, -74.0687];
const KIRYAS_JOEL: [number, number] = [41.3401, -74.1668];

const hhmm = (d: Date | null): string => {
  assert.ok(d, "expected a time, got null");
  return d!.toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
};
const minutesOf = (d: Date | null): number => {
  const [h, m] = hhmm(d).split(":").map(Number);
  return h * 60 + m;
};
/** Our own astronomy vs the reference figures: within two minutes is honest. */
const closeTo = (actual: Date | null, expected: string, label: string, tol = 2) => {
  const [eh, em] = expected.split(":").map(Number);
  const diff = Math.abs(minutesOf(actual) - (eh * 60 + em));
  assert.ok(diff <= tol, `${label}: got ${hhmm(actual)}, expected ~${expected} (off by ${diff} min)`);
};

// ── sunset, against figures computed independently with @hebcal/core ─────────
// Candle lighting is sunset − 18, so these also pin the reference values quoted
// to Izzy: 7:05pm / 4:09pm / 8:14pm.
test("sunset matches the reference calculation across the year", () => {
  closeTo(sunset("2026-09-04", ...MONSEY), "19:23", "Monsey 4 Sep 2026");
  closeTo(sunset("2026-12-04", ...MONSEY), "16:27", "Monsey 4 Dec 2026");
  closeTo(sunset("2027-06-25", ...MONSEY), "20:32", "Monsey 25 Jun 2027");
});

test("candle lighting is 18 minutes before sunset", () => {
  closeTo(candleLighting("2026-09-04", ...MONSEY), "19:05", "4 Sep candles");
  closeTo(candleLighting("2026-12-04", ...MONSEY), "16:09", "4 Dec candles");
  closeTo(candleLighting("2027-06-25", ...MONSEY), "20:14", "25 Jun candles");
  assert.equal(DEFAULT_CANDLE_LIGHTING_MINUTES, 18);
});

test("the candle-lighting offset is configurable", () => {
  const ss = sunset("2026-12-04", ...MONSEY)!;
  const c40 = candleLighting("2026-12-04", ...MONSEY, 40)!;
  assert.equal(Math.round((ss.getTime() - c40.getTime()) / 60_000), 40);
});

// ── the four opinions ────────────────────────────────────────────────────────
test("Satmar nightfall is a fixed 72 minutes after sunset", () => {
  for (const d of ["2026-12-04", "2027-06-25"]) {
    const ss = sunset(d, ...MONSEY)!;
    const nf = nightfall(d, ...MONSEY, "satmar")!;
    assert.equal(Math.round((nf.getTime() - ss.getTime()) / 60_000), 72, `${d} should be sunset + 72`);
  }
});

test("Satmar is the default, because failing late is the safe direction", () => {
  assert.equal(DEFAULT_NIGHTFALL_SHITA, "satmar");
  const d = "2026-12-04";
  const def = nightfall(d, ...MONSEY);
  const satmar = nightfall(d, ...MONSEY, "satmar");
  assert.equal(def!.getTime(), satmar!.getTime());
  // The default must never be EARLIER than any other opinion on offer — that is
  // the whole safety argument.
  for (const s of NIGHTFALL_SHITOS) {
    assert.ok(def!.getTime() >= nightfall(d, ...MONSEY, s.id)!.getTime(),
      `default must not be earlier than ${s.id}`);
  }
});

test("Chabad's 8.5 degrees lands ~22 minutes before Satmar", () => {
  // The number Izzy is deciding on. If this drifts, the recommendation changes.
  for (const [d, lo, hi] of [["2026-12-04", 18, 32], ["2027-06-25", 15, 30]] as const) {
    const gap = Math.round(
      (nightfall(d, ...MONSEY, "satmar")!.getTime() - nightfall(d, ...MONSEY, "chabad")!.getTime()) / 60_000);
    assert.ok(gap >= lo && gap <= hi, `${d}: Satmar is ${gap} min after Chabad, expected ${lo}-${hi}`);
  }
});

test("the fixed-minute opinions are exactly what they say", () => {
  const d = "2026-12-04";
  const ss = sunset(d, ...MONSEY)!;
  assert.equal(Math.round((nightfall(d, ...MONSEY, "rmoshe")!.getTime() - ss.getTime()) / 60_000), 50);
  assert.equal(Math.round((nightfall(d, ...MONSEY, "medium")!.getTime() - ss.getTime()) / 60_000), 42);
});

test("every published opinion resolves for the communities we serve", () => {
  for (const place of [MONSEY, KIRYAS_JOEL]) {
    for (const s of NIGHTFALL_SHITOS) {
      assert.ok(nightfall("2027-01-15", ...place, s.id), `${s.id} must resolve`);
    }
  }
});

// ── ordering and sanity ──────────────────────────────────────────────────────
test("candle lighting precedes sunset precedes nightfall", () => {
  const d = "2027-03-19";
  const c = candleLighting(d, ...MONSEY)!, s = sunset(d, ...MONSEY)!, n = nightfall(d, ...MONSEY)!;
  assert.ok(c < s && s < n, `expected ${c.toISOString()} < ${s.toISOString()} < ${n.toISOString()}`);
});

test("sunrise comes before sunset", () => {
  const d = "2026-09-04";
  assert.ok(sunrise(d, ...MONSEY)! < sunset(d, ...MONSEY)!);
});

test("Kiryas Joel and Monsey differ by only a minute or two", () => {
  // They are 25 km apart; a bigger gap means a coordinate or sign error.
  for (const d of ["2026-12-04", "2027-06-25"]) {
    const gap = Math.abs(minutesOf(sunset(d, ...MONSEY)) - minutesOf(sunset(d, ...KIRYAS_JOEL)));
    assert.ok(gap <= 3, `${d}: ${gap} minutes apart, expected <= 3`);
  }
});

test("sunset tracks the seasons in the right direction", () => {
  // Latest sunset near the summer solstice, earliest near the winter one.
  const jun = minutesOf(sunset("2027-06-21", ...MONSEY));
  const dec = minutesOf(sunset("2026-12-21", ...MONSEY));
  assert.ok(jun > dec + 180, `summer sunset ${jun} should be far later than winter ${dec}`);
});

// ── the polar case: never return nothing where a phone has to reopen ─────────
test("above the Arctic circle Chabad falls back rather than returning nothing", () => {
  // Tromsø in June: the sun never reaches 8.5 degrees below the horizon. The
  // degrees-based answer genuinely does not exist, but nightfall() must still
  // produce a time or the phone would never reopen.
  const TROMSO: [number, number] = [69.6492, 18.9553];
  assert.equal(degreesAfterSunset("2027-06-21", ...TROMSO, 8.5), null, "no 8.5 deg crossing in polar summer");
  const ss = sunset("2027-06-21", ...TROMSO);
  if (ss) assert.ok(nightfall("2027-06-21", ...TROMSO, "chabad"), "must still answer");
});

test("a fixed-minute opinion needs only a sunset", () => {
  const OSLO: [number, number] = [59.9139, 10.7522];
  assert.ok(nightfall("2027-01-15", ...OSLO, "satmar"));
});
