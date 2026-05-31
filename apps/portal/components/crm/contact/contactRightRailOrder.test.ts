import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RIGHT_RAIL_SECTION_ORDER,
  loadRightRailSectionOrder,
  moveRightRailSection,
  normalizeRightRailSectionOrder,
  resetRightRailSectionOrder,
  rightRailOrderStorageKey,
  RIGHT_RAIL_SECTION_IDS,
  saveRightRailSectionOrder,
} from "./contactRightRailOrder";

test("default section order matches current right-rail layout", () => {
  assert.deepEqual(DEFAULT_RIGHT_RAIL_SECTION_ORDER, [
    "right-rail-relationship",
    "right-rail-activity",
    "right-rail-outreach-rules",
    "right-rail-open-tasks",
    "right-rail-scratch-notes",
    "right-rail-business-profile",
    "right-rail-contact-info",
  ]);
});

test("normalizeRightRailSectionOrder applies saved order and appends missing sections", () => {
  const normalized = normalizeRightRailSectionOrder([
    "right-rail-open-tasks",
    "right-rail-relationship",
    "unknown-section",
    "right-rail-relationship",
  ]);
  assert.deepEqual(normalized, [
    "right-rail-open-tasks",
    "right-rail-relationship",
    "right-rail-activity",
    "right-rail-outreach-rules",
    "right-rail-scratch-notes",
    "right-rail-business-profile",
    "right-rail-contact-info",
  ]);
});

test("moveRightRailSection reorders without duplicates", () => {
  const next = moveRightRailSection(
    DEFAULT_RIGHT_RAIL_SECTION_ORDER,
    "right-rail-relationship",
    "right-rail-activity",
    "after",
  );
  assert.deepEqual(next, [
    "right-rail-activity",
    "right-rail-relationship",
    "right-rail-outreach-rules",
    "right-rail-open-tasks",
    "right-rail-scratch-notes",
    "right-rail-business-profile",
    "right-rail-contact-info",
  ]);
});

test("moveRightRailSection before target inserts above target", () => {
  const next = moveRightRailSection(
    DEFAULT_RIGHT_RAIL_SECTION_ORDER,
    "right-rail-contact-info",
    "right-rail-open-tasks",
    "before",
  );
  assert.equal(next.indexOf("right-rail-contact-info"), next.indexOf("right-rail-open-tasks") - 1);
});

test("loadRightRailSectionOrder applies saved section order", () => {
  const storage = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      removeItem: (k: string) => {
        storage.delete(k);
      },
    },
  });
  try {
    saveRightRailSectionOrder(
      ["right-rail-contact-info", "right-rail-relationship", "right-rail-activity"],
      "agent-42",
    );
    assert.deepEqual(loadRightRailSectionOrder("agent-42"), [
      "right-rail-contact-info",
      "right-rail-relationship",
      "right-rail-activity",
      "right-rail-outreach-rules",
      "right-rail-open-tasks",
      "right-rail-scratch-notes",
      "right-rail-business-profile",
    ]);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  }
});

test("resetRightRailSectionOrder clears storage key and returns default order", () => {
  const key = rightRailOrderStorageKey("user-123");
  const storage = new Map<string, string>();
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
      removeItem: (k: string) => {
        storage.delete(k);
      },
    },
  });
  try {
    storage.set(key, JSON.stringify(["right-rail-open-tasks", "right-rail-relationship"]));
    const reset = resetRightRailSectionOrder("user-123");
    assert.deepEqual(reset, [...RIGHT_RAIL_SECTION_IDS]);
    assert.equal(storage.get(key), undefined);
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  }
});
