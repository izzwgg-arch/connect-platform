import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  extractPromptBaseKey,
  candidateStorageKeysForRow,
  findCachedAudioForRow,
  listStoredAudioFilenames,
  rowHasCachedAudio,
  sanitizeBaseName,
  sanitizeTenantScope,
  buildTenantStorageKey,
  isTenantScopedStorageKey,
  writePromptFile,
  readPromptFile,
} from "./promptStorage";

function mkTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-storage-test-"));
  process.env.PROMPT_STORAGE_DIR = root;
  return root;
}

function writeTenantFile(
  root: string,
  scope: string,
  name: string,
  bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]),
): void {
  const dir = scope === "unassigned" ? path.join(root, "unassigned") : path.join(root, "tenants", scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
}

function writeFlatLegacyFile(
  root: string,
  name: string,
  bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]),
): void {
  fs.writeFileSync(path.join(root, name), bytes);
}

// ── Helpers ───────────────────────────────────────────────────────────

test("sanitizeTenantScope normalises ids and defaults unassigned", () => {
  assert.equal(sanitizeTenantScope("clxabc123"), "clxabc123");
  assert.equal(sanitizeTenantScope("  clxabc "), "clxabc");
  assert.equal(sanitizeTenantScope(null), "unassigned");
  assert.equal(sanitizeTenantScope(""), "unassigned");
  assert.equal(sanitizeTenantScope("../../etc/passwd"), "______etc_passwd");
});

test("buildTenantStorageKey produces tenant-scoped paths", () => {
  assert.equal(buildTenantStorageKey("t1", "main", ".wav"), "tenants/t1/main.wav");
  assert.equal(buildTenantStorageKey(null, "main", ".wav"), "unassigned/main.wav");
  assert.equal(buildTenantStorageKey("", "x", ".mp3"), "unassigned/x.mp3");
});

test("isTenantScopedStorageKey recognises new vs legacy paths", () => {
  assert.equal(isTenantScopedStorageKey("tenants/t1/main.wav"), true);
  assert.equal(isTenantScopedStorageKey("unassigned/main.wav"), true);
  assert.equal(isTenantScopedStorageKey("main.wav"), false, "legacy flat path must be rejected");
  assert.equal(isTenantScopedStorageKey(""), false);
  assert.equal(isTenantScopedStorageKey(null), false);
});

// ── Legacy helpers kept in place ──────────────────────────────────────

test("extractPromptBaseKey normalises every VitalPBX reference shape", () => {
  assert.equal(extractPromptBaseKey("custom/KJ_Play_Center"), "KJ_Play_Center");
  assert.equal(extractPromptBaseKey("/var/lib/asterisk/sounds/custom/KJ_Play_Center.wav"), "KJ_Play_Center");
  assert.equal(extractPromptBaseKey("/usr/share/asterisk/sounds/en/custom/foo.gsm"), "foo");
  assert.equal(extractPromptBaseKey("en/custom/bar.mp3"), "bar");
  assert.equal(extractPromptBaseKey("KJ_Play_Center.WAV"), "KJ_Play_Center");
  assert.equal(extractPromptBaseKey("just_a_name"), "just_a_name");
  assert.equal(extractPromptBaseKey(""), "");
  assert.equal(extractPromptBaseKey(null), "");
});

test("sanitizeBaseName lower-cases and collapses punctuation", () => {
  assert.equal(sanitizeBaseName("KJ_Play_Center.wav"), "kj_play_center");
  assert.equal(sanitizeBaseName("A+ Center Welcome"), "a_center_welcome");
  assert.equal(sanitizeBaseName(""), "");
});

test("candidateStorageKeysForRow emits ONLY tenant-scoped candidates", () => {
  const keysA = candidateStorageKeysForRow({
    tenantId: "tenantA",
    promptRef: "custom/Main",
    fileBaseName: "Main",
    displayName: "Main",
    relativePath: "custom/Main",
  });
  // Every candidate must live under this tenant's directory.
  for (const k of keysA) {
    assert.ok(
      k.startsWith("tenants/tenantA/") || k === "tenants/tenantA/Main.wav",
      `candidate leaked outside tenantA scope: ${k}`,
    );
  }
  assert.ok(keysA.includes("tenants/tenantA/main.wav"));
  assert.ok(keysA.includes("tenants/tenantA/Main.wav"));

  const keysB = candidateStorageKeysForRow({
    tenantId: "tenantB",
    promptRef: "custom/Main",
    fileBaseName: "Main",
  });
  for (const k of keysB) {
    assert.ok(k.startsWith("tenants/tenantB/"), `candidate leaked outside tenantB scope: ${k}`);
  }
  // The two tenants' candidate sets must be disjoint.
  const overlap = keysA.filter((k) => keysB.includes(k));
  assert.equal(overlap.length, 0, `candidates leaked across tenants: ${overlap.join(", ")}`);
});

// ── Isolation-focused playback tests ──────────────────────────────────

test("findCachedAudioForRow: tenant A NEVER resolves to tenant B's file", async () => {
  const root = mkTmpRoot();
  // Two different tenants, same filename — exactly the pre-fix collision.
  writeTenantFile(root, "tenantA", "main.wav", Buffer.from("A-BYTES"));
  writeTenantFile(root, "tenantB", "main.wav", Buffer.from("B-BYTES"));

  const mA = await findCachedAudioForRow({
    tenantId: "tenantA",
    promptRef: "custom/Main",
    fileBaseName: "Main",
  });
  assert.ok(mA, "tenant A should resolve");
  assert.equal(mA!.storageKey, "tenants/tenantA/main.wav");
  const bufA = await readPromptFile(mA!.storageKey);
  assert.equal(bufA.toString(), "A-BYTES", "tenant A received tenant A's bytes");

  const mB = await findCachedAudioForRow({
    tenantId: "tenantB",
    promptRef: "custom/Main",
    fileBaseName: "Main",
  });
  assert.ok(mB);
  assert.equal(mB!.storageKey, "tenants/tenantB/main.wav");
  const bufB = await readPromptFile(mB!.storageKey);
  assert.equal(bufB.toString(), "B-BYTES", "tenant B received tenant B's bytes");
});

test("findCachedAudioForRow: case-insensitive inside the tenant dir", async () => {
  const root = mkTmpRoot();
  writeTenantFile(root, "tenantA", "KJ_Play_Center.wav");
  const m = await findCachedAudioForRow({
    tenantId: "tenantA",
    promptRef: "custom/kj_play_center",
    fileBaseName: "kj_play_center",
  });
  assert.ok(m);
  assert.ok(m!.storageKey.startsWith("tenants/tenantA/"), `expected tenant-scoped hit, got ${m!.storageKey}`);
});

test("findCachedAudioForRow: returns null when only a LEGACY flat file is on disk", async () => {
  const root = mkTmpRoot();
  writeFlatLegacyFile(root, "main.wav", Buffer.from("LEAK"));
  // Tenant scope lookup should not find it — legacy flat files are
  // refused to preserve tenant isolation.
  const m = await findCachedAudioForRow({
    tenantId: "tenantA",
    promptRef: "custom/Main",
    fileBaseName: "Main",
  });
  assert.equal(m, null, "legacy flat file must not resolve under any tenant scope");
});

test("listStoredAudioFilenames returns per-scope maps", async () => {
  const root = mkTmpRoot();
  writeTenantFile(root, "tenantA", "alpha.wav");
  writeTenantFile(root, "tenantB", "beta.mp3");
  writeTenantFile(root, "unassigned", "orphan.gsm");
  const map = await listStoredAudioFilenames();

  assert.ok(map.get("tenantA")?.has("alpha.wav"));
  assert.ok(map.get("tenantB")?.has("beta.mp3"));
  assert.ok(map.get("unassigned")?.has("orphan.gsm"));
  // Tenant A's map must NOT see tenant B's file.
  assert.equal(map.get("tenantA")?.has("beta.mp3") ?? false, false);
});

test("rowHasCachedAudio scopes lookup to the row's tenant only", async () => {
  const root = mkTmpRoot();
  writeTenantFile(root, "tenantA", "main.wav");
  writeTenantFile(root, "tenantB", "main.wav");
  const map = await listStoredAudioFilenames();

  const hitA = rowHasCachedAudio(
    { tenantId: "tenantA", promptRef: "custom/Main", fileBaseName: "Main" },
    map,
  );
  assert.equal(hitA.hit, true);
  if (hitA.hit) assert.equal(hitA.storageKey, "tenants/tenantA/main.wav");

  const hitB = rowHasCachedAudio(
    { tenantId: "tenantB", promptRef: "custom/Main", fileBaseName: "Main" },
    map,
  );
  assert.equal(hitB.hit, true);
  if (hitB.hit) assert.equal(hitB.storageKey, "tenants/tenantB/main.wav");

  // Tenant C (no file on disk) must MISS even though other tenants
  // have the same filename.
  const missC = rowHasCachedAudio(
    { tenantId: "tenantC", promptRef: "custom/Main", fileBaseName: "Main" },
    map,
  );
  assert.equal(missC.hit, false, "tenant C must not see any other tenant's audio");
});

test("writePromptFile + readPromptFile round-trip under tenant scope", async () => {
  mkTmpRoot();
  const buf = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00]);
  const stored = await writePromptFile({
    tenantScope: "tenantX",
    baseName: "My Prompt!",
    originalFilename: "My Prompt!.wav",
    buffer: buf,
  });
  assert.equal(stored.storageKey, "tenants/tenantX/my_prompt.wav");
  assert.equal(stored.contentType, "audio/wav");
  const back = await readPromptFile(stored.storageKey);
  assert.deepEqual(Array.from(back), Array.from(buf));
});

test("writePromptFile: unassigned scope writes under unassigned/", async () => {
  mkTmpRoot();
  const stored = await writePromptFile({
    tenantScope: null,
    baseName: "orphan",
    originalFilename: "orphan.mp3",
    buffer: Buffer.from("MP3"),
  });
  assert.equal(stored.storageKey, "unassigned/orphan.mp3");
});
