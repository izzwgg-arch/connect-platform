# The portal's CSP must keep `'wasm-unsafe-eval'` — or the desk-phone scan page silently stops scanning

The customer desk-phone scan link (`/phone-setup/<token>`) decodes barcodes on the
customer's own phone with a WebAssembly library (zxing), served from our own origin at
`/zxing/zxing_reader.wasm`. That only works if the portal's Content-Security-Policy
`script-src` directive includes `'wasm-unsafe-eval'` (or the broader `'unsafe-eval'`).
Without it, the browser's `WebAssembly.instantiate()` call throws — silently, because
the page's own error handling catches that and falls back to a much slower "photograph
the sticker" mode instead of crashing. Nothing on screen says why; it just reads as "the
camera doesn't really scan." This exact failure shipped live for a full day on
2026-09-17 (round 21) because the only check anyone ran beforehand was "does the wasm
file download" (it did, 200, `application/wasm`) — which proves nothing about whether
the browser can actually compile it under the page's CSP. The required line, exactly as
it must read, lives in `/etc/nginx/connectcomms/security-headers.conf` on the Connect
server (loopcom, 45.14.194.179) — this file feeds both `app.connectcomunications.com`
and `app.loopcom.net` — and must contain:

```
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https:;
```

This file is **live server state, not tracked in this git repository**. A portal code
deploy can never restore it, and it can be lost by a server rebuild, an nginx config
restore from an older backup, or anyone hand-editing that shared file without carrying
the `'wasm-unsafe-eval'` token forward. The round-21 fix's own backup of the working
config sits at `/root/security-headers.conf.bak-20260917-021803` on that same server,
for reference if this ever needs restoring by hand.

To check it from anywhere with network access to the site, run:

```
curl -sI https://app.loopcom.net/phone-setup/x | grep -i content-security-policy
```

and confirm `wasm-unsafe-eval` appears in the `script-src` list of the line that comes
back. A `wasm_reader.wasm` request answering 200 is **not** proof by itself — the only
real proof is that instantiation succeeds, which is exactly what this header controls.
`scripts/deploy-portal.sh`'s verify stage now runs this same check automatically after
every portal deploy (set `DEPLOY_PORTAL_SKIP_CSP_CHECK=1` to skip it in an environment
with no public nginx in front of the portal), so a regression here fails the deploy
instead of waiting for a customer to notice. (If the probe cannot connect at all it only
warns — a healthy portal is never rolled back over an edge hiccup; check by hand.)
