/**
 * Where the approval prompt lands (2026-09-09). Before this it always went to the
 * primary display's bottom-right corner — on top of the chat panel it was asking
 * about (the bubble's home is that same corner), and on the wrong monitor when the
 * bubble lived on a second screen.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { approvalPositionFor, APPROVAL_WIDTH, APPROVAL_HEIGHT } from "./approvalWindow";
import { CHAT_WIDTH, CHAT_HEIGHT, type Rect } from "../coworkerWidget/widgetGeometry";

const WA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND: Rect = { x: 1920, y: 0, width: 2560, height: 1400 };
const chatAt = (x: number, y: number): Rect => ({ x, y, width: CHAT_WIDTH, height: CHAT_HEIGHT });

test("no chat showing: the bottom-right corner of the work area, 24px in (the old behaviour)", () => {
  assert.deepEqual(approvalPositionFor(null, WA), { x: 1920 - APPROVAL_WIDTH - 24, y: 1040 - APPROVAL_HEIGHT - 24 });
  assert.deepEqual(approvalPositionFor(null, SECOND), { x: 1920 + 2560 - APPROVAL_WIDTH - 24, y: 1400 - APPROVAL_HEIGHT - 24 });
});

test("chat in its usual bottom-right home: the prompt sits to its LEFT, bottom-aligned, never over it", () => {
  const chat = chatAt(1920 - 64 - 24 - CHAT_WIDTH - 12, 1040 - 24 - CHAT_HEIGHT);
  const at = approvalPositionFor(chat, WA);
  assert.equal(at.x + APPROVAL_WIDTH + 12, chat.x, "12px gap, to the left");
  assert.equal(at.y + APPROVAL_HEIGHT, chat.y + chat.height, "bottom edges line up");
  assert.ok(at.x >= WA.x);
});

test("chat against the left edge: the prompt goes to its RIGHT", () => {
  const chat = chatAt(0, 300);
  const at = approvalPositionFor(chat, WA);
  assert.equal(at.x, CHAT_WIDTH + 12);
  assert.equal(at.y, 300 + CHAT_HEIGHT - APPROVAL_HEIGHT);
});

test("no room either side: centred over the chat, clamped inside the work area", () => {
  const narrow: Rect = { x: 0, y: 0, width: 800, height: 700 };
  const chat = chatAt(200, 60);
  const at = approvalPositionFor(chat, narrow);
  assert.equal(at.x, 200 + Math.round((CHAT_WIDTH - APPROVAL_WIDTH) / 2));
  assert.equal(at.y, 60 + (CHAT_HEIGHT - APPROVAL_HEIGHT) / 2);
  assert.ok(at.x >= 0 && at.x + APPROVAL_WIDTH <= 800);
  assert.ok(at.y >= 0 && at.y + APPROVAL_HEIGHT <= 700);
});

test("a chat on the second monitor keeps the prompt on that monitor's work area", () => {
  const chat = chatAt(1920 + 2560 - CHAT_WIDTH - 100, 1400 - CHAT_HEIGHT - 24);
  const at = approvalPositionFor(chat, SECOND);
  assert.ok(at.x >= SECOND.x && at.x + APPROVAL_WIDTH <= SECOND.x + SECOND.width);
  assert.ok(at.y >= SECOND.y && at.y + APPROVAL_HEIGHT <= SECOND.y + SECOND.height);
  assert.equal(at.x + APPROVAL_WIDTH + 12, chat.x);
});

test("a chat taller than the prompt near the top never pushes the prompt above the work area", () => {
  const at = approvalPositionFor(chatAt(1000, -200), WA);
  assert.ok(at.y >= 0);
  const low = approvalPositionFor(chatAt(1000, 1040 - 100), WA);
  assert.ok(low.y + APPROVAL_HEIGHT <= 1040, "and never below it");
});
