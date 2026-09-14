# ⛔⛔ AGENT HANDOFF — every api and portal deploy was rolling ITSELF back while the platform was perfectly healthy (2026-08-21) — READ FIRST before touching `deploy_{api,portal}_rollout_wait_ready`, before reading `http_code=000` as an outage, before writing a "wait until no deploy is running" loop, or when a deploy fails at "public verify"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_DEPLOY_PUBLIC_VERIFY_LOOPBACK_2026-08-21.md`**
(`9af55418` on `feat/ivr-migration-takeover`, pushed. **Deploy tooling only — no api/portal/worker
code, no migration, no PBX write, no env-file edit, no tenant row, and no customer was affected at
any point.** ✅ **PROVEN by real deploys: api `done adde5d4f` with
`DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1` — the exact configuration that had been failing — and
portal `done 502da3de` through the full blue/green rollout on the new code. Containers:
`app-api-1` = `d3891d64`, `app-portal-1` = `adde5d4f`, both of which CONTAIN `9af55418`. Health
**200** on `/api/health`, `/` and `/ready` on BOTH hostnames.**)

- ⛔⛔ **THE HEADLINE: `DEPLOY_{API,PORTAL}_PUBLIC_VERIFY_RESOLVE_LOCAL=1` curls
  `--resolve host:443:127.0.0.1`, and nginx had no `127.0.0.1:443` listener.** The probe could not
  make a TCP connection at all, burned its whole 30×2 s budget, logged
  `public verify probe failed … http_code=000`, and **correctly rolled a perfectly good deploy
  back**. Three jobs died that way on three different commits from two sessions.
  ⛔ **`http_code=000` is a CONNECTION failure, not a bad HTTP status. Never read it as "the app is
  down"** — the platform answered 200 on both hostnames the entire time.
- ⛔⛔ **THE FLAG IS IN NO FILE. It lives ONLY in the pm2 process environment of
  `connect-deploy-worker`** — not in `.env.deploy-queue`, not in systemd, and nothing in the repo
  sets it. Read it with `tr '\0' '\n' < /proc/<pid>/environ | grep RESOLVE`.
  ⛔ **That is why the bug looked intermittent and why two paths disagreed:** `deploy-direct.sh`
  sources `.env.deploy-queue` (no flag → `0` → passed) while a QUEUE job inherited `=1` from pm2
  (→ failed). Same commit, same minute, opposite outcomes.
- ✅ **THE FIX: the loopback path is PREFERRED, never MANDATORY.**
  `deploy_{api,portal}_rollout_probe_resolve_specs()` returns loopback first then an empty entry
  meaning "ordinary DNS", and `wait_ready` tries every spec **inside the same attempt** — so a
  missing listener costs one extra curl and heals instantly instead of failing the deploy. It fails
  only when BOTH paths fail, and logs which one won. ⛔ The hairpin-403 workaround keeps its intent
  (loopback still goes first and still wins when it can); `RESOLVE_LOCAL=0` behaviour is unchanged;
  and `http://` candidate `/ready` probes still never get a `--resolve`.
- ✅ **The portal probe used to fail SILENTLY** — the api side has logged a diagnostic since it
  shipped, the portal side had none, so a rolled-back portal deploy said only "not ready after
  cutover" with no code to read. Both sides now print every path's code and say in words that 000 is
  a connection failure.
- ⛔⛔ **A ROLLOUT-SCRIPT CHANGE CANNOT TAKE EFFECT ON THE DEPLOY THAT SHIPS IT.**
  `deploy-api.sh` sources `scripts/lib/deploy-api-rollout.sh` at **line 31** and runs
  `deploy_common_git_sync` at **line 84** — the rollout code is the PRE-SYNC copy already in bash's
  memory. **Budget two deploys** when changing anything under `scripts/lib/deploy-*-rollout.sh`.
- ✅ **nginx half (done by a parallel session at 13:06, KEPT):** `listen 127.0.0.1:443 ssl http2;`
  added to all four vhosts. Backup **`/root/nginx-backup-20260821T110618Z-loopback443/`**; rollback
  = copy the four files back, `nginx -t`, `systemctl reload nginx`. It is defence in depth and it
  was **not sufficient alone** — the listener is one certbot rewrite away from vanishing, and until
  `9af55418` that silently took the whole pipeline down again.
  ⛔ `/etc/nginx/sites-enabled/connectcomms` is a **real file, not a symlink** — editing
  `sites-available/connectcomms` changes nothing and looks like a successful fix.
- ✅ **Proof: `scripts/lib/deploy-rollout-probe.test.sh`** (`pnpm test:deploy-rollout`) stubs `curl`
  and `sleep`, touches no network, **24 assertions pass — and 11 FAIL when replayed against
  `HEAD`**, including the two that reproduce the incident. Plus a **live A/B against production
  nginx** using the real deployed functions with the loopback target swapped to `127.0.0.9` (no
  listener): OLD api → `http_code=000` failure; NEW api → `ok via dns` rc=0; OLD portal → **silent**
  failure; NEW portal → `ok via dns` rc=0. And on the box, `bash scripts/lib/deploy-rollout-probe.test.sh`
  inside `/opt/connectcomms/app` reads **24 passed, 0 failed** on the exact files the next deploy sources.
- ⛔⛔ **FOUND IN PASSING — a "wait for the deploy to finish" loop that SELF-MATCHES and can never
  fire, and it was jamming a second session too.**
  `until ! ps -eo cmd | grep -qE "[d]eploy-direct.sh|…"; do sleep 15; done; … bash scripts/deploy-direct.sh portal …`
  has `deploy-direct.sh` **in its own command line**, so the guard is true forever. One had been
  spinning 46 minutes, and another session's enqueue loop counted the same pattern and was therefore
  permanently blocked by its mere existence. Killed. **Wait on the INVOKED scripts
  (`[d]eploy-api.sh|[d]eploy-portal.sh|[r]un-heavy`), never on `deploy-direct.sh` from a wrapper that
  itself names `deploy-direct.sh`.** This trap is already in this file and keeps being rewritten.
- ⚠️ **`verify: container commit <X> matches target` naming an OLDER sha than `done <Y>` is CORRECT,
  not the stale-code hazard** — the clone syncs to tip `Y` but verify compares against the last
  commit that touched service-relevant paths, so a docs/agent-only commit on top legitimately leaves
  the container at `X`.
- ⏳ **Still open, and it is Izzy's call:** the flag remains invisible in pm2's env only, so the
  queue and `deploy-direct.sh` still run with different probe configuration and nobody can discover
  that by reading a file. Putting it in `.env.deploy-queue` explicitly (either value) would make it
  visible — deliberately NOT done here (AGENTS.md rule 10 forbids agents editing
  `/opt/connectcomms/env/`). ⏳ **No job has gone through the QUEUE since the fix** — both proofs are
  `deploy-direct.sh` with the flag exported by hand (same code, same env, not literally the worker).
  The next queue job is the acceptance test; watch for `public verify ok via …` in its log.
