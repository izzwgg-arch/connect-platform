const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
export async function packet(secret, direction, body, nonce = hex(crypto.getRandomValues(new Uint8Array(24)))) {
  const p = { version: 1, nonce, time: Date.now(), body: JSON.stringify(body), mac: "" };
  p.mac = await mac(secret, direction, p); return p;
}
async function mac(secret, direction, p) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${direction}\n${p.version}\n${p.nonce}\n${p.time}\n${p.body}`)));
}
export async function verified(secret, p, expectedNonce) {
  if (!p || p.version !== 1 || p.nonce !== expectedNonce || !Number.isSafeInteger(p.time) || Math.abs(Date.now() - p.time) > 30000 || typeof p.body !== "string" || p.body.length > 2*1024*1024) throw Error("untrusted_bridge_response");
  const expected = await mac(secret, "desktop", p);
  if (typeof p.mac !== "string" || expected.length !== p.mac.length || [...expected].reduce((n, c, i) => n | (c.charCodeAt(0) ^ p.mac.charCodeAt(i)), 0)) throw Error("untrusted_bridge_response");
  return JSON.parse(p.body);
}
