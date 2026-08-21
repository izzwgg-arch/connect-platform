# AGENT HANDOFF — every api and portal deploy was rolling itself back, and the platform was healthy the whole time (2026-08-21)

**Scope:** the blue/green "public verify" probe in `scripts/lib/deploy-api-rollout.sh` and
`scripts/lib/deploy-portal-rollout.sh`. **No api/portal/worker code, no migration, no PBX write,
no env-file edit, no tenant row, no customer affected at any point.**

Commit: `9af55418` — *fix(deploy): a missing loopback listener was rolling healthy deploys back*
(on `feat/ivr-migration-takeover`, pushed).

---

## 1. What was actually wrong

`DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1` and `DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL=1` make
the post-cutover probe run

```
curl --resolve <host>:443:127.0.0.1 https://<host>/…
```

The flag exists to dodge a **hairpin nginx 403**: curling your own public hostname from the origin
box arrives with the server's own public IP as the client address, and some origins deny that.
Mapping the hostname to loopback keeps the client address at `127.0.0.1` while still exercising
TLS + nginx + upstream, because SNI is unchanged.

⛔⛔ **That only works when nginx actually LISTENS on `127.0.0.1:443`, and it did not.** nginx bound
`45.14.194.179:443`, `169.58.213.204:443` and `[::]:443` — no IPv4 loopback socket. So the probe
could never make a TCP connection at all. It burned its entire budget (30 attempts × 2 s), logged

```
[deploy-api-rollout] public verify probe failed: url=… http_code=000 resolve_local=1 tls_insecure=0
[deploy-api] FAIL: public verify URL not ready after cutover: …
```

and **correctly rolled a perfectly good deploy back**. At least three jobs died this way, on three
different commits, from two different sessions, before anyone connected the dots.

⛔ **`http_code=000` is a CONNECTION failure, not a bad HTTP status.** It reads like an outage and
it is not one. The platform answered **200** on both hostnames throughout — verified by curling the
public IP and `127.0.0.1:3001/health` while the rollbacks were happening.

⛔ **And the hairpin 403 the flag exists to dodge is NOT currently occurring.** Measured on the box:
plain-DNS `https://app.connectcomunications.com/api/health` → **200**, `remote_ip=45.14.194.179`.
So the workaround was buying nothing and costing everything.

### Where the flag comes from — it is in no file

`grep -rn RESOLVE_LOCAL` finds **nothing** in `/opt/connectcomms/env/.env.deploy-queue`, nothing in
`/etc/systemd/system`, and nothing in the repo that *sets* it. It lives **only in the pm2 process
environment of `connect-deploy-worker`** (read it with
`tr '\0' '\n' < /proc/<pid>/environ | grep RESOLVE`). It therefore survives in pm2's saved dump and
nowhere else.

⛔ **This is why the two deploy paths disagreed and the bug looked intermittent:**
`scripts/deploy-direct.sh` sources `.env.deploy-queue`, which does **not** contain the flag, so a
**direct** deploy ran with `RESOLVE_LOCAL=0` and passed; a **queue** deploy inherited `=1` from pm2
and failed. Same commit, same minute, opposite outcomes.

---

## 2. The fix

**The loopback path is now PREFERRED, never MANDATORY.**

`deploy_{api,portal}_rollout_probe_resolve_specs()` returns an ordered list of `curl --resolve`
specs — loopback first, then an empty entry meaning "no `--resolve`, ordinary DNS". `wait_ready`
tries every spec **inside the same attempt**, so a missing loopback listener costs one extra curl
per attempt and heals instantly instead of failing the deploy. It only fails when **both** paths
fail, and it now logs which path won.

Deliberate properties:

- ⛔ **The hairpin workaround keeps its intent.** Loopback is still tried first and still wins when
  it can, so an origin that really does 403 its own address is still protected. The fallback only
  engages when the preferred path cannot connect.
- ⛔ **`http://` probes are untouched.** The candidate `/ready` check on `127.0.0.1:3004` never gets
  a `--resolve` — the flag only applies to `https://` URLs, as before.
- ⛔ **`RESOLVE_LOCAL=0` behaviour is byte-identical to before** — one spec, no `--resolve`, no
  extra curl, no extra log line.
- ✅ **The portal probe used to fail SILENTLY.** The api side has logged a diagnostic since it
  shipped; the portal side had none at all, so a rolled-back portal deploy said only "not ready
  after cutover" with no code to read. Both sides now report **every** path's code and spell out
  that `000` means a connection failure.

### Why the fix cannot take effect on the deploy that ships it

`scripts/deploy-api.sh` sources `scripts/lib/deploy-api-rollout.sh` at **line 31**, and
`deploy_common_git_sync` runs at **line 84**. The rollout code is therefore the **pre-sync** copy
already in bash's memory. **The deploy that ships a rollout-script change still runs the OLD
rollout code; the NEXT one runs the new one.** Budget two deploys when changing anything in
`scripts/lib/deploy-*-rollout.sh`.

---

## 3. The nginx half — already done by a parallel session, and kept

At **13:06 local on 2026-08-21** another session added `listen 127.0.0.1:443 ssl http2;` to all four
vhosts (`connectcomms`, `connectcomms-loopcom`, `connectcomms-sip`, `connectcomms-sip-loopcom`).
Backup: **`/root/nginx-backup-20260821T110618Z-loopback443/`** (all four originals).
Rollback: copy the four files back into `/etc/nginx/sites-enabled/`, `nginx -t`, `systemctl reload nginx`.

That change is **kept** — it is defence in depth, `nginx -t` is clean, and it makes the *preferred*
probe path work. **It was not sufficient on its own**, which is exactly why the script fix matters:
the listener is one certbot rewrite or one config restore away from disappearing, and until this
commit that silently took the whole deploy pipeline down again.

⛔ `/etc/nginx/sites-enabled/connectcomms` is a **real file, not a symlink** (the other three are
symlinks) — editing `sites-available/connectcomms` changes nothing and looks like a successful fix.

---

## 4. Evidence

**Unit / behavioural** — `scripts/lib/deploy-rollout-probe.test.sh` (registered as
`pnpm test:deploy-rollout`). Stubs `curl` and `sleep` as shell functions, so it touches no network
and needs no server. **24 assertions pass** on the fix.
✅ **Proven non-vacuous: 11 of them FAIL when replayed against `HEAD`**, including the two headline
cases — *"loopback dead + dns healthy → success (was a rollback)"* for api and portal.

**Live A/B against production nginx** (read-only; the real functions from the deployed clone, with
the loopback target swapped to `127.0.0.9`, which has no listener and reproduces the incident):

| case | result |
|---|---|
| OLD api code, dead loopback | `public verify probe failed … http_code=000 resolve_local=1` — the incident, reproduced |
| NEW api code, dead loopback | `public verify ok via dns` → **rc=0** |
| OLD portal code, dead loopback | **silent failure, no log at all** |
| NEW portal code, dead loopback | `public verify ok via dns` → **rc=0** |

**Real deploys.** `bash scripts/deploy-direct.sh api --branch feat/ivr-migration-takeover` with
`DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1` — i.e. the exact configuration that had been failing —
logged the new code twice and completed:

```
[deploy-api-rollout] public verify prefers loopback SNI (…); falls back to ordinary DNS if nothing listens on 127.0.0.1:443
[deploy-api-rollout] public verify ok via app.connectcomunications.com:443:127.0.0.1 url=…/api/health   (after cutover)
[deploy-api-rollout] public verify ok via app.connectcomunications.com:443:127.0.0.1 url=…/api/health   (after normalization)
[deploy-api] done adde5d4f requested_by=direct:root
```

Portal deployed the same way with `DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL=1`.

**Server-side test run.** `bash scripts/lib/deploy-rollout-probe.test.sh` inside
`/opt/connectcomms/app` — the exact files the next deploy will source — **24 passed, 0 failed**, and
`file` reports them as plain LF shell scripts (the CRLF trap that has bitten `scripts/pbx` twice).

---

## 5. Things found in passing

- ⛔⛔ **A dead deploy waiter had been spinning for ~46 minutes and was jamming other sessions.**
  `bash -c 'until ! ps -eo cmd | grep -qE "[d]eploy-direct.sh|[r]un-heavy"; do sleep 15; done; … bash scripts/deploy-direct.sh portal …'`
  **self-matches**: its own command line contains the literal `deploy-direct.sh` from the payload it
  is waiting to run, so the guard is true forever and it can NEVER fire. Worse, a *second* session's
  enqueue loop counted the same pattern and was therefore also blocked permanently by its mere
  existence. This exact trap is already in CLAUDE.md and it keeps being rewritten.
  **Write the waiter so the payload is not in the waiting process's own cmdline** — put the deploy in
  a separate script file and wait on `pgrep -f 'deploy-(api|portal)\.sh'`, or match on
  `[d]eploy-api.sh|[d]eploy-portal.sh|[r]un-heavy` (the *invoked* scripts), never on
  `deploy-direct.sh` from a wrapper that itself names `deploy-direct.sh`.
- ⚠️ **`verify: container commit <X> matches target` can name an OLDER sha than `done <Y>`** and that
  is correct, not the stale-code hazard: the clone syncs to the branch tip `Y`, but the verify
  compares against the last commit that touched service-relevant paths. A docs- or agent-only commit
  on top legitimately leaves the container at `X`.
- ⛔ `/etc/connect-robot/credentials.env` still cannot be `source`d (documented elsewhere) — not
  needed for any of this.

---

## 6. Not fixed / still open

- ⏳ **`RESOLVE_LOCAL=1` still lives only in the pm2 process env of `connect-deploy-worker`, in no
  file.** It is now harmless either way, so this was deliberately left alone rather than editing
  `/opt/connectcomms/env/` (AGENTS.md rule 10). But it means the queue and `deploy-direct.sh` still
  run with *different* probe configuration, and nobody can discover that by reading a file.
  **If someone wants them to agree, the honest fix is to put the flag in `.env.deploy-queue`
  explicitly (either value) so it is visible — that is Izzy's call, not an agent's.**
- ⏳ **Nobody has re-run a deploy through the QUEUE** (`POST /ops/deploy/enqueue`) since the fix —
  both proofs above are `deploy-direct.sh` runs with the flag exported by hand, which is the same
  code path and the same env, but not literally the worker. The next queue job is the acceptance
  test; watch for `public verify ok via …` in its log.
- ⏳ **The hairpin 403 has never been observed on this box.** If it ever starts happening, the
  fallback will silently mask it by succeeding via DNS with a `403`… no — `curl -fsS` treats 403 as
  a failure, so a real hairpin 403 still fails the DNS leg and the loopback leg still wins. No
  masking. Stated explicitly because it is the obvious worry.
