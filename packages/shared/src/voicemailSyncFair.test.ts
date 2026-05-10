import test from "node:test";
import assert from "node:assert/strict";
import {
  interleaveVoicemailHelperSlots,
  selectDistinctFairHelperPicks,
  type VoicemailHelperFairSlot,
} from "./voicemailSyncFair";

test("interleave alternates tenants before second extension on same tenant", () => {
  type S = VoicemailHelperFairSlot & { tag: string };
  const m = new Map<string, S[]>();
  m.set("t_b", [{ tenantId: "t_b", extNumber: "1", tag: "b1" }]);
  m.set("t_a", [
    { tenantId: "t_a", extNumber: "2", tag: "a2" },
    { tenantId: "t_a", extNumber: "10", tag: "a10" },
  ]);
  const out = interleaveVoicemailHelperSlots(m);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.tag, "a2");
  assert.equal(out[1]!.tag, "b1");
  assert.equal(out[2]!.tag, "a10");
});

test("97 mailboxes / budget 32: four cycles cover all with rotating cursor", () => {
  type S = VoicemailHelperFairSlot & { n: number };
  const m = new Map<string, S[]>();
  const slots: S[] = [];
  for (let i = 0; i < 97; i++) {
    const s = { tenantId: "solo", extNumber: String(100 + i), n: i };
    slots.push(s);
  }
  m.set("solo", slots);
  const interleaved = interleaveVoicemailHelperSlots(m);
  assert.equal(interleaved.length, 97);

  let cursor = 0;
  const coverage = new Set<string>();
  for (let cycle = 0; cycle < 4; cycle++) {
    const { picks, nextStartIndex } = selectDistinctFairHelperPicks(
      interleaved,
      32,
      cursor,
      (x) => `${x.tenantId}:${x.extNumber}`,
    );
    cursor = nextStartIndex;
    assert.ok(picks.length <= 32);
    for (const p of picks) {
      coverage.add(`${p.tenantId}:${p.extNumber}`);
    }
  }
  assert.equal(coverage.size, 97, "every mailbox should be scheduled at least once within 4 cycles");
});

test("heavy tenant does not occupy first 32 slots when another tenant exists", () => {
  type S = VoicemailHelperFairSlot & { tag: string };
  const m = new Map<string, S[]>();
  m.set("heavy", Array.from({ length: 50 }, (_, i) => ({ tenantId: "heavy", extNumber: String(i), tag: `h${i}` })));
  m.set("light", Array.from({ length: 47 }, (_, i) => ({ tenantId: "light", extNumber: String(200 + i), tag: `l${i}` })));
  const interleaved = interleaveVoicemailHelperSlots(m);
  const { picks } = selectDistinctFairHelperPicks(interleaved, 32, 0, (x) => `${x.tenantId}:${x.extNumber}`);
  const heavyFirst32 = picks.filter((p) => p.tenantId === "heavy").length;
  const lightFirst32 = picks.filter((p) => p.tenantId === "light").length;
  assert.ok(heavyFirst32 < 32, "heavy should not take all 32 slots");
  assert.ok(lightFirst32 >= 1, "light should get at least one slot in first batch");
  assert.equal(heavyFirst32 + lightFirst32, 32);
});

test("selectDistinctFairHelperPicks skips duplicate keys when ring wraps", () => {
  const items = [
    { tenantId: "a", extNumber: "1" },
    { tenantId: "a", extNumber: "2" },
  ];
  const { picks } = selectDistinctFairHelperPicks(items, 10, 0, (x) => `${x.tenantId}:${x.extNumber}`);
  assert.equal(picks.length, 2);
});
