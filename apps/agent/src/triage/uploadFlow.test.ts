/**
 * Chat MP3 upload → hold-music flow (owner request 2026-07-27).
 *
 * Pinned behaviors:
 *  - Audio uploads create the asset+profile through the api door, then OFFER
 *    to set it (scope question embeds the exact profile name).
 *  - A message that already says "set/use it" chains straight into the fully
 *    gated MOH set flow (regular user → own extension, admin scope rules).
 *  - Replies to the offer resume deterministically: decline keeps it saved,
 *    "whole company" / "yes" execute through handleMoh.
 *  - Upload failures are reported honestly — never "done".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TriageOrchestrator } from "./orchestrator";

function makePrisma(opts: { role?: string; ownExt?: string | null; messages?: any[]; profiles?: any[] } = {}): any {
  return {
    tenantPbxLink: { findUnique: async () => ({ pbxTenantId: "21" }) },
    extension: { findFirst: async () => (opts.ownExt === null ? null : { extNumber: opts.ownExt ?? "101" }) },
    user: { findUnique: async () => ({ role: opts.role ?? "USER" }) },
    mohProfile: {
      findMany: async () =>
        opts.profiles ?? [
          { id: "prof-jazz", name: "Jazz" },
          { id: "prof-party", name: "Party Mix" },
        ],
    },
    mohScheduleConfig: { findUnique: async () => ({ timezone: "America/New_York" }) },
    mohOverrideState: { findUnique: async () => ({ isActive: false, profileId: null }) },
    mohExtensionOverride: { findFirst: async () => null },
    agentMessage: { findMany: async () => opts.messages ?? [] },
  };
}

function makeOrch(created: any[], prisma: any, uploads: any[], opts: { status?: string; uploadError?: boolean } = {}) {
  const actions: any = {
    create: async (input: any) => {
      created.push(input);
      return { id: "act1", status: opts.status ?? "EXECUTED" };
    },
  };
  const mohUpload = {
    upload: async (input: any) => {
      if (opts.uploadError) throw new Error("moh_upload_error status=422");
      uploads.push(input);
      return { profile: { id: "prof-party", name: "Party Mix" }, mohClassName: "connect_acme_party_mix", tracks: input.files.length };
    },
  };
  return new TriageOrchestrator(prisma, {} as any, actions, async () => null, null, mohUpload);
}

const CTX = { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" as const, conversationId: "conv1" };
const FILES = [{ path: "/tmp/a.mp3", filename: "Party Mix.mp3", sizeBytes: 1024 * 1024 }];

test("UPLOAD: audio file becomes a profile and the agent OFFERS to set it (no silent execution)", async () => {
  const created: any[] = [];
  const uploads: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN", ownExt: "101" }), uploads);
  const out = await orch.handle({ kind: "audio_upload", raw: "here's a new song for you", files: FILES }, CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].name, "Party Mix");
  assert.equal(created.length, 0); // no action until the client answers the offer
  assert.match(out.reply ?? "", /saved your music as hold-music profile "Party Mix"/);
  assert.match(out.reply ?? "", /whole company, or just your extension \(101\)/);
});

test("UPLOAD: playlist (several files) is reported as a playlist", async () => {
  const uploads: any[] = [];
  const orch = makeOrch([], makePrisma({ role: "TENANT_ADMIN" }), uploads);
  const files = [
    { path: "/tmp/a.mp3", filename: "One.mp3", sizeBytes: 1000 },
    { path: "/tmp/b.mp3", filename: "Two.mp3", sizeBytes: 1000 },
  ];
  const out = await orch.handle({ kind: "audio_upload", raw: "playlist for the office", files }, CTX, "en");
  assert.equal(uploads[0].files.length, 2);
  assert.match(out.reply ?? "", /playlist of 2 tracks/);
});

test("UPLOAD: explicit name in the message wins over the filename", async () => {
  const uploads: any[] = [];
  const orch = makeOrch([], makePrisma({ role: "TENANT_ADMIN" }), uploads);
  await orch.handle({ kind: "audio_upload", raw: 'upload this and call it "Friday Vibes"', files: FILES }, CTX, "en");
  assert.equal(uploads[0].name, "Friday Vibes");
});

test("UPLOAD: 'use this as our hold music for the whole company' chains into an executed M1 set", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN", ownExt: "101" }), []);
  const out = await orch.handle(
    { kind: "audio_upload", raw: "use this as our hold music for the whole company", files: FILES },
    CTX,
    "en",
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.equal(created[0].params.profileId, "prof-party");
  assert.match(out.reply ?? "", /saved your music/);
  assert.match(out.reply ?? "", /Done/);
});

test("UPLOAD: regular user chaining a set lands on THEIR extension (pbx.M2)", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "USER", ownExt: "104" }), []);
  await orch.handle({ kind: "audio_upload", raw: "set this as my hold music please", files: FILES }, CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M2");
  assert.equal(created[0].params.objectId, "104");
});

test("UPLOAD: conversion failure is reported honestly, nothing executes", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN" }), [], { uploadError: true });
  const out = await orch.handle({ kind: "audio_upload", raw: "new hold music", files: FILES }, CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /couldn't process/);
  assert.doesNotMatch(out.reply ?? "", /saved/);
});

test("UPLOAD: no upload client configured → honest escalation", async () => {
  const orch = new TriageOrchestrator(makePrisma(), {} as any, { create: async () => ({}) } as any, async () => null, null, null);
  const out = await orch.handle({ kind: "audio_upload", raw: "music", files: FILES }, CTX, "en");
  assert.equal(out.handled, true);
  assert.match(out.reply ?? "", /passed it to our team/);
});

// ── offer resume ─────────────────────────────────────────────────────────────

const OFFER_MSG =
  'I\'ve saved your music as hold-music profile "Party Mix". Should I set it now — for the whole company, or just your extension (101)? You can also say "not now".';

test("OFFER RESUME: 'whole company' executes M1 with the offered profile", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "TENANT_ADMIN", ownExt: "101", messages: [{ role: "assistant", content: OFFER_MSG, contentEn: null }] });
  const orch = makeOrch(created, prisma, []);
  const out = await orch.handle({ kind: "chat", raw: "whole company" } as any, CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.equal(created[0].params.profileId, "prof-party");
  assert.match(out.reply ?? "", /Done/);
});

test("OFFER RESUME: 'just my extension' executes M2 on the admin's own extension", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "TENANT_ADMIN", ownExt: "101", messages: [{ role: "assistant", content: OFFER_MSG, contentEn: null }] });
  const orch = makeOrch(created, prisma, []);
  await orch.handle({ kind: "chat", raw: "just my extension" } as any, CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M2");
  assert.equal(created[0].params.objectId, "101");
  assert.equal(created[0].params.profileId, "prof-party");
});

test("OFFER RESUME: 'yes' from a regular user sets their own extension", async () => {
  const created: any[] = [];
  const offerUser = 'I\'ve saved your music as hold-music profile "Party Mix". Want me to set it as your extension (104)\'s hold music now? You can also say "not now".';
  const prisma = makePrisma({ role: "USER", ownExt: "104", messages: [{ role: "assistant", content: offerUser, contentEn: null }] });
  const orch = makeOrch(created, prisma, []);
  const out = await orch.handle({ kind: "chat", raw: "yes please" } as any, CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created[0].capabilityId, "pbx.M2");
  assert.equal(created[0].params.objectId, "104");
});

test("OFFER RESUME: 'not now' keeps it saved and executes NOTHING", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "TENANT_ADMIN", ownExt: "101", messages: [{ role: "assistant", content: OFFER_MSG, contentEn: null }] });
  const orch = makeOrch(created, prisma, []);
  const out = await orch.handle({ kind: "chat", raw: "not now" } as any, CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /is saved/);
});

test("OFFER RESUME: unrelated small talk falls through (handled:false)", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "TENANT_ADMIN", ownExt: "101", messages: [{ role: "assistant", content: OFFER_MSG, contentEn: null }] });
  const orch = makeOrch(created, prisma, []);
  const out = await orch.handle({ kind: "chat", raw: "what are your office hours?" } as any, CTX, "en");
  assert.equal(out.handled, false);
  assert.equal(created.length, 0);
});
