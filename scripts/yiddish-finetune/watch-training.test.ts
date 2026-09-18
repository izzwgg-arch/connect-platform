/**
 * Tests for the training watcher's two pure parts. Both encode a real
 * 2026-09-18 failure: the kernel status string that had to be classified, and
 * the kernel log whose single useful line was buried under ~1,500 tqdm
 * repaints.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyKernelStatus, errorLinesFromKernelLog } from "./watch-training";

test("classifyKernelStatus maps Kaggle's status strings to run outcomes", () => {
  assert.deepEqual(classifyKernelStatus('x has status "KernelWorkerStatus.COMPLETE"'), { kind: "done", state: "COMPLETE" });
  assert.deepEqual(classifyKernelStatus('x has status "KernelWorkerStatus.ERROR"'), { kind: "error", state: "ERROR" });
  assert.equal(classifyKernelStatus('x has status "KernelWorkerStatus.RUNNING"').kind, "running");
  assert.equal(classifyKernelStatus('x has status "KernelWorkerStatus.QUEUED"').kind, "running");
  // An unknown state must read as still-running, never as success: calling a
  // state we do not recognise "done" would report a training run as finished
  // when it is not.
  assert.equal(classifyKernelStatus("something new").kind, "running");
});

test("errorLinesFromKernelLog keeps the real error and drops progress-bar spam", () => {
  const log = JSON.stringify([
    { stream_name: "stderr", data: "Map:  50%|#####     | 232/464 [00:07<00:07, 30.93 examples/s]" },
    { stream_name: "stderr", data: "  0%|          | 0/2000 [00:05<?, ?it/s]" },
    { stream_name: "stderr", data: 'File "/kaggle/working/train.py", line 179, in build_model_and_processor' },
    { stream_name: "stderr", data: "TypeError: WhisperForConditionalGeneration.__init__() got an unexpected keyword argument 'dtype'" },
    { stream_name: "stderr", data: "[NbConvertApp] Writing 298522 bytes to __results__.html" },
  ]);
  const lines = errorLinesFromKernelLog(log);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /unexpected keyword argument 'dtype'/);
  assert.ok(!lines.some((l) => l.includes("examples/s") || l.includes("it/s]") || l.startsWith("[NbConvertApp]")));
});

test("errorLinesFromKernelLog never throws on a log it cannot parse", () => {
  assert.deepEqual(errorLinesFromKernelLog("not json at all"), []);
});

test("the reported error is the ROOT cause, not papermill's re-raise of it", () => {
  // Verbatim shape of Kaggle run v6: the real error is 4 lines in, the tail is
  // papermill saying a subprocess exited 1 — which is true and tells you nothing.
  const log = JSON.stringify([
    { data: "Traceback (most recent call last):" },
    { data: '  File "/kaggle/working/train.py", line 319, in run_training' },
    { data: "    trainer.train()" },
    { data: "RuntimeError: element 0 of tensors does not require grad and does not have a grad_fn" },
    { data: "Traceback (most recent call last):" },
    { data: "  File papermill/execute.py, line 251" },
    { data: "CalledProcessError: Command '['/usr/bin/python3', 'train.py']' returned non-zero exit status 1." },
  ]);
  const lines = errorLinesFromKernelLog(log);
  assert.match(lines[lines.length - 1], /does not require grad/);
  assert.ok(!lines.some((l) => l.includes("CalledProcessError")), "papermill's wrapper must not be the headline");
});
