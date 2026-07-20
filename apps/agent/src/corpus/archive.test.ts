import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArchiveIngestor, MemoryArchiveProgress, fileKey, collectionOf, type ArchiveProgress } from "./archive";
import { CorpusService } from "./corpus";
import { SEED_GLOSSARY } from "./glossary";
import { AuditLog } from "../audit/audit";

const audit = new AuditLog([{ async write() {} }]);
const glossary = async () => SEED_GLOSSARY;

function makePrisma() {
  const rows: any[] = [];
  return {
    rows,
    agentTranscript: {
      upsert: async ({ where, create, update }: any) => {
        const ex = rows.find((r) => r.recordingId === where.recordingId);
        if (ex) { Object.assign(ex, update); return ex; }
        const row = { id: `t${rows.length + 1}`, createdAt: new Date(), ...create }; rows.push(row); return row;
      },
      count: async ({ where }: any = {}) => rows.filter((r) => !where || Object.entries(where).every(([k, v]: any) => r[k] === v)).length,
    },
  };
}

class FakeProgress implements ArchiveProgress {
  done = new Set<string>();
  async isDone(k: string) { return this.done.has(k); }
  async markDone(k: string) { this.done.add(k); }
  async stats() { return { processed: this.done.size }; }
}

test("fileKey is stable + collection derived from top folder", () => {
  assert.equal(fileKey("/x/a.wav"), fileKey("/x/a.wav"));
  assert.equal(collectionOf("/archive", "/archive/comedy/show1.mp3"), "comedy");
  assert.equal(collectionOf("/archive", "/archive/Kids Stories/s1.wav"), "kids_stories");
});

test("walks an archive tree and finds only audio files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arc-"));
  await mkdir(path.join(root, "comedy"), { recursive: true });
  await writeFile(path.join(root, "comedy", "a.mp3"), "x");
  await writeFile(path.join(root, "comedy", "notes.txt"), "x");
  await writeFile(path.join(root, "b.wav"), "x");
  const ing = new ArchiveIngestor(new CorpusService(makePrisma() as any, audit, glossary), new FakeProgress(), null, audit);
  const files = await ing.listAudio(root);
  assert.equal(files.length, 2); // a.mp3 + b.wav, not notes.txt
});

test("drain processes a batch, tags collection, and marks progress (resumes)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arc-"));
  await mkdir(path.join(root, "comedy"), { recursive: true });
  for (let i = 0; i < 5; i++) await writeFile(path.join(root, "comedy", `s${i}.mp3`), "x");
  const progress = new FakeProgress();
  // transcriber stub returns text so capture happens
  const transcriber = { async transcribe() { return { ok: true, text: "היינטיגע קאמעדי", language: "yi", provider: "stub" }; } };
  const prisma = makePrisma();
  const ing = new ArchiveIngestor(new CorpusService(prisma as any, audit, glossary), progress, transcriber, audit);
  const r1 = await ing.drain(root, 3);
  assert.equal(r1.processed, 3);
  assert.equal(r1.transcribed, 3);
  const r2 = await ing.drain(root, 10);
  assert.equal(r2.processed, 2); // remaining 2 — did not re-do the first 3
  const r3 = await ing.drain(root, 10);
  assert.equal(r3.processed, 0); // all done
  assert.equal(prisma.rows.length, 5); // 5 captured into corpus
  assert.ok(prisma.rows.every((x: any) => x.source === "bulk_import"));
});

test("without a transcriber, files are still cataloged (walked) but not captured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arc-"));
  await writeFile(path.join(root, "a.wav"), "x");
  const prisma = makePrisma();
  const ing = new ArchiveIngestor(new CorpusService(prisma as any, audit, glossary), new FakeProgress(), null, audit);
  const r = await ing.drain(root, 10);
  assert.equal(r.processed, 1);
  assert.equal(r.transcribed, 0);
  assert.equal(prisma.rows.length, 0); // nothing to capture without transcription
});

test("MemoryArchiveProgress persists via AgentMemory upsert", async () => {
  const store: any = {};
  const prisma = {
    agentMemory: {
      findUnique: async ({ where }: any) => store[where.tenantId_key.key] ?? null,
      upsert: async ({ where, create }: any) => { store[where.tenantId_key.key] = create; return create; },
      count: async () => Object.keys(store).length,
    },
  };
  const p = new MemoryArchiveProgress(prisma as any);
  assert.equal(await p.isDone("k1"), false);
  await p.markDone("k1", { path: "/x" });
  assert.equal(await p.isDone("k1"), true);
  assert.equal((await p.stats()).processed, 1);
});
