import { test } from "node:test";
import assert from "node:assert/strict";
import { api, createUser, testApp } from "../testing/harness.js";
import { signMediaUrl } from "./service.js";

async function tinyPng(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer();
}

function multipart(fields: Record<string, string>, file: { field: string; filename: string; contentType: string; buffer: Buffer }) {
  const boundary = `----commTest${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

test("upload an image, get variants, thumb is webp", async () => {
  const app = await testApp();
  const user = await createUser(app);
  const png = await tinyPng();
  const { boundary, body } = multipart({}, { field: "file", filename: "pic.png", contentType: "image/png", buffer: png });
  const up = await api(app, { method: "POST", url: "/media", token: user.accessToken, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.asset.status, "READY");
  assert.ok(up.body.asset.variants.thumb);
  assert.ok(up.body.asset.variants.medium);

  const thumb = await api(app, { method: "GET", url: `/media/file/${up.body.asset.id}/thumb` });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers["content-type"], "image/webp");
  assert.equal(thumb.headers["cache-control"], "public, max-age=31536000, immutable");
});

test("a .txt disguised as .png is refused by byte-sniffing", async () => {
  const app = await testApp();
  const user = await createUser(app);
  const fake = Buffer.from("this is plain text pretending to be an image, well past 12 bytes");
  const { boundary, body } = multipart({}, { field: "file", filename: "pic.png", contentType: "image/png", buffer: fake });
  const up = await api(app, { method: "POST", url: "/media", token: user.accessToken, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(up.status, 400);
  assert.equal(up.body.error, "file_type");
});

test("private asset needs a signature or the owner's token", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const stranger = await createUser(app);
  const png = await tinyPng();
  const { boundary, body } = multipart({ private: "1" }, { field: "file", filename: "secret.png", contentType: "image/png", buffer: png });
  const up = await api(app, { method: "POST", url: "/media", token: owner.accessToken, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(up.status, 201);
  assert.equal(up.body.asset.isPrivate, true);
  const id = up.body.asset.id;

  const noSig = await api(app, { method: "GET", url: `/media/file/${id}/thumb` });
  assert.equal(noSig.status, 404);

  const strangerTry = await api(app, { method: "GET", url: `/media/file/${id}/thumb`, token: stranger.accessToken });
  assert.equal(strangerTry.status, 404);

  const ownerTry = await api(app, { method: "GET", url: `/media/file/${id}/thumb`, token: owner.accessToken });
  assert.equal(ownerTry.status, 200);

  const signed = new URL(signMediaUrl(id, "thumb"));
  const withSig = await api(app, { method: "GET", url: `${signed.pathname}${signed.search}` });
  assert.equal(withSig.status, 200);
  assert.equal(withSig.headers["cache-control"], "private, no-store");
});

test("owner can delete their own asset; it's gone after", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const png = await tinyPng();
  const { boundary, body } = multipart({}, { field: "file", filename: "pic.png", contentType: "image/png", buffer: png });
  const up = await api(app, { method: "POST", url: "/media", token: owner.accessToken, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
  const id = up.body.asset.id;

  const meta = await api(app, { method: "GET", url: `/media/${id}`, token: owner.accessToken });
  assert.equal(meta.status, 200);

  const del = await api(app, { method: "DELETE", url: `/media/${id}`, token: owner.accessToken });
  assert.equal(del.status, 200);

  const after = await api(app, { method: "GET", url: `/media/${id}`, token: owner.accessToken });
  assert.equal(after.status, 404);
  const file = await api(app, { method: "GET", url: `/media/file/${id}/thumb` });
  assert.equal(file.status, 404);
});

test("GET /me/media lists the owner's own uploads", async () => {
  const app = await testApp();
  const owner = await createUser(app);
  const png = await tinyPng();
  for (let i = 0; i < 2; i++) {
    const { boundary, body } = multipart({}, { field: "file", filename: `pic${i}.png`, contentType: "image/png", buffer: png });
    const up = await api(app, { method: "POST", url: "/media", token: owner.accessToken, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(up.status, 201);
  }
  const list = await api(app, { method: "GET", url: "/me/media", token: owner.accessToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 2);
});
