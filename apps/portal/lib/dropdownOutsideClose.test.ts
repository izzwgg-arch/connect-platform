/**
 * Guards for the "device picker closes the popover without saving" bug
 * (2026-08-27, mini dialer Headset/Speaker/Ringer settings).
 *
 * ConnectSelect's option panel rides ViewportDropdown, which portals to
 * <body>. Any ancestor popover with a document-level "click outside closes
 * me" listener therefore sees a press on a dropdown OPTION as outside
 * itself and closes at mousedown/pointerdown — unmounting the dropdown
 * before the option's click (mouseup) can fire, so onChange never runs and
 * the selection is silently lost. The native <select> these pickers
 * replaced (ConnectSelect sweep f6c61735) rendered its options in an
 * OS-level popup that produced no document mousedown, which is why the bug
 * arrived with that update.
 *
 * The defect lives in the CALLERS (the outside-close handlers), so these
 * are source guards: a unit test of ConnectSelect passes straight through
 * the bug. Reads are CRLF-normalised (Windows checkouts are CRLF).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (rel: string) =>
  readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

test("ViewportDropdown exports the portaled-panel membership check and keeps its marker class", () => {
  const src = read("components/ViewportDropdown.tsx");
  assert.ok(
    src.includes("export function isInsideViewportDropdown"),
    "isInsideViewportDropdown must stay exported — both dialers' outside-close handlers depend on it",
  );
  assert.ok(
    src.includes('.closest(".viewport-dropdown")'),
    "the helper must match on the .viewport-dropdown class",
  );
  assert.ok(
    src.includes("viewport-dropdown ${className}") || src.includes("viewport-dropdown "),
    "the portaled panel must keep the viewport-dropdown class the helper matches on",
  );
});

test("mini dialer settings popover ignores mousedown inside a portaled dropdown panel", () => {
  const src = read("components/DesktopMiniDialer.tsx");
  assert.ok(
    src.includes('import { isInsideViewportDropdown } from "./ViewportDropdown"'),
    "DesktopMiniDialer must import isInsideViewportDropdown",
  );
  const guardAt = src.indexOf("if (isInsideViewportDropdown(t)) return;");
  const closeAt = src.indexOf("setSettingsOpen(false)");
  assert.ok(guardAt >= 0, "the outside-close handler must early-return on portaled-panel clicks");
  assert.ok(closeAt >= 0, "the settings outside-close must still exist");
  assert.ok(
    guardAt < closeAt,
    "the portaled-panel check must run BEFORE the settings popover is closed — " +
      "closing first unmounts the dropdown at mousedown and loses the selection",
  );
});

test("floating dialer shell ignores pointerdown inside a portaled dropdown panel", () => {
  const src = read("components/FloatingDialer.tsx");
  assert.ok(
    src.includes('import { isInsideViewportDropdown } from "./ViewportDropdown"'),
    "FloatingDialer must import isInsideViewportDropdown",
  );
  const handlerStart = src.indexOf("const handlePointerDown");
  assert.ok(handlerStart >= 0, "the shell outside-close handler must still exist");
  const handlerEnd = src.indexOf('document.addEventListener("pointerdown"', handlerStart);
  assert.ok(handlerEnd > handlerStart, "could not bound the handlePointerDown body");
  const body = src.slice(handlerStart, handlerEnd);
  const guardAt = body.indexOf("if (isInsideViewportDropdown(target)) return;");
  const closeAt = body.indexOf("setOpen(false)");
  assert.ok(guardAt >= 0, "handlePointerDown must early-return on portaled-panel presses");
  assert.ok(closeAt >= 0, "handlePointerDown must still close the shell on a genuine outside press");
  assert.ok(
    guardAt < closeAt,
    "the portaled-panel check must run BEFORE setOpen(false) — " +
      "closing first tears down the whole dialer before the device pick can land",
  );
});
