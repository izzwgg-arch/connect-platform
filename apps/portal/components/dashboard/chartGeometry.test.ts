import assert from "node:assert/strict";
import test from "node:test";
import { chartTickIndices, smoothLine, trafficWindowLabel } from "./chartGeometry";

test("call curves stay within each observed segment, including zero plateaus", () => {
  for (const counts of [[3, 3, 4, 0, 0, 0, 2], [0, 1000, 0, 1, 0], [0, 0, 0], [7, 7], [1, 2, 3, 4]]) {
    const points = counts.map((count, i) => ({ x: 44 + i * 80, y: 208 - count }));
    const curves = smoothLine(points).split(" C ").slice(1);
    curves.forEach((curve, i) => {
      const [cx1, cy1, cx2, cy2, x2, y2] = curve.split(/[ ,]+/).map(Number);
      const p = points[i]!;
      for (let step = 0; step <= 100; step++) {
        const t = step / 100, u = 1 - t;
        const x = u ** 3 * p.x + 3 * u ** 2 * t * cx1! + 3 * u * t ** 2 * cx2! + t ** 3 * x2!;
        const y = u ** 3 * p.y + 3 * u ** 2 * t * cy1! + 3 * u * t ** 2 * cy2! + t ** 3 * y2!;
        assert.ok(y >= Math.min(p.y, y2!) - 1e-9 && y <= Math.max(p.y, y2!) + 1e-9);
        assert.ok(x >= p.x - 1e-9 && x <= x2! + 1e-9);
      }
    });
  }
});

test("empty and single-bucket charts have valid paths", () => {
  assert.equal(smoothLine([]), "");
  assert.equal(smoothLine([{ x: 50, y: 100 }]), "M 50 100");
});

test("ticks adapt to narrow widths without dropping the last date", () => {
  assert.deepEqual(chartTickIndices(0, 240), []);
  assert.deepEqual(chartTickIndices(1, 240), [0]);
  for (const count of [2, 7, 30, 48, 365]) {
    for (const width of [212, 340, 700, 1300]) {
      const ticks = chartTickIndices(count, width);
      assert.equal(ticks[0], 0);
      assert.equal(ticks.at(-1), count - 1);
      assert.equal(new Set(ticks).size, ticks.length);
      assert.ok(ticks.length <= Math.max(2, Math.floor(width / 120)));
    }
  }
});

test("date caption uses API timezone and exclusive end, including DST", () => {
  assert.equal(trafficWindowLabel(null), null);
  assert.equal(trafficWindowLabel({ timezone: "UTC" }), null);
  const label = trafficWindowLabel({ windowFrom: "2026-09-08T04:00:00Z", windowTo: "2026-09-15T04:00:00Z", timezone: "America/New_York" });
  assert.match(label!, /Sep 8, 2026.*Sep 14, 2026/);
  assert.ok(!label!.includes("Sep 15"));
  const day = trafficWindowLabel({ windowFrom: "2026-11-01T04:00:00Z", windowTo: "2026-11-02T05:00:00Z", timezone: "America/New_York" });
  assert.equal(day, "Nov 1, 2026 · America/New_York");
});
