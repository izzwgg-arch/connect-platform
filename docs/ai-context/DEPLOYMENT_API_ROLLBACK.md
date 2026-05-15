# API blue/green deploy — rollback runbook

> Use when **`scripts/deploy-api.sh`** exits during the blue/green path (`DEPLOY_API_BLUEGREEN=1`, default) or nginx/container state is ambiguous after a failed job.

**Do not** use manual `docker compose up` / `git pull` for production recovery except break-glass; prefer re-enqueueing a known-good commit via the deploy queue (`AGENTS.md`).

**Operational note (`commit_already_deployed`):** **`commit_already_deployed`** applies only after a **real** **`dryRun: false`** success for that **`commitHash`** (the queue compares the requested pin to **`deployed_commit`** on the latest **non–dry-run** successful job). **Dry-run** jobs must **not** satisfy this skip — if you still see a dry-run blocking live deploys, upgrade **`connect-deploy-queue`** to **1.1.1+**. If you need another live blue/green after a noop skip that does not match running containers, see **`AGENTS.md`** (post-deploy SHA verification) and **`KNOWN_ISSUES.md`**.

---

## Normal failure behavior (automated)

### Readiness probe contract (JWT)

`scripts/deploy-api.sh` (blue/green, default) polls **`GET /ready`** on **`127.0.0.1:3004`** (candidate) and **`127.0.0.1:3001`** (stable) **without an `Authorization` header**.

The Fastify app exempts **`/health`**, **`/ready`**, and **`/api/ready`** from the global JWT **`preHandler`** via **`apps/api/src/jwtPublicRouteBypass.ts`** (`shouldSkipJwtVerification`). If **`/ready` returns `401`**, the candidate never becomes healthy and promotion **cannot** succeed — fix that bypass list (keep `/ready` next to `/health`), then re-enqueue.

**`GET /health`** stays the lightweight liveness check (**`200`** quickly); **`GET /ready`** remains readiness (**`200`** when listening + DB + not draining; **`503`** while booting or draining).

---

- **Candidate `/ready` never succeeds:** candidate is stopped/removed; nginx upstream unchanged.
- **`nginx -t` or reload fails after pointing at candidate:** script restores the previous upstream port from the backup `.pre-<job-tag>` sibling and reloads; candidate stopped.
- **Public verify URL fails after cutover:** same nginx rollback + candidate stopped.
- **Stable recreate succeeds but `/ready` on :3001 fails:** nginx pointed back at candidate `:3004` (if reload works); deploy exits non-zero — **traffic may remain on candidate** until an operator fixes stable or completes rollback below.
- **Reload fails while normalizing to :3001:** log says traffic may remain on candidate — fix nginx/upstream manually.

The deploy script **clears `trap ERR`** around the rollout so a rollout failure **does not** invoke **git rollback** (which could remove a still-needed candidate).

---

## Check current state

1. **Upstream file** (default `DEPLOY_NGINX_API_UPSTREAM_ACTIVE_FILE` or `/opt/connectcomms/nginx/connect-api-upstream-active.conf`):

   ```bash
   cat /opt/connectcomms/nginx/connect-api-upstream-active.conf
   ```

   Expect **`server 127.0.0.1:3001;`** when normalized, or **`...:3004;`** mid-rollout or stuck after a partial failure.

2. **Containers:**

   ```bash
   docker compose -f docker-compose.app.yml ps api
   docker compose -f docker-compose.app.yml --profile api_rollout ps api_candidate
   ```

3. **Local readiness:**

   ```bash
   curl -fsS http://127.0.0.1:3001/ready || echo "stable not ready"
   curl -fsS http://127.0.0.1:3004/ready || echo "no candidate"
   ```

4. **Nginx errors** (avoid 502 churn):

   ```bash
   sudo tail -100 /var/log/nginx/error.log
   ```

---

## Recover: traffic should be on stable (3001)

If nginx still points at **3004** but stable **3001** is healthy:

```bash
printf 'server 127.0.0.1:3001;\n' | sudo tee /opt/connectcomms/nginx/connect-api-upstream-active.conf
sudo nginx -t && sudo nginx -s reload
```

Then remove the candidate:

```bash
docker compose -f docker-compose.app.yml --profile api_rollout stop api_candidate
docker compose -f docker-compose.app.yml --profile api_rollout rm -sf api_candidate
```

---

## Recover: rollback stable container to previous image/code

Stable is recreated **after** cutover to candidate; if the **new** stable is bad but candidate was good, operators may temporarily point nginx back to **3004** (candidate must still be running — start it if needed):

```bash
docker compose -f docker-compose.app.yml --profile api_rollout up -d api_candidate
# wait for /ready on 3004, then:
printf 'server 127.0.0.1:3004;\n' | sudo tee /opt/connectcomms/nginx/connect-api-upstream-active.conf
sudo nginx -t && sudo nginx -s reload
```

Then enqueue a fix or re-deploy a known-good SHA. **Candidate is disposable** once a good stable exists again.

---

## Restore upstream from backup

Rollout backs up the active file before changes:

```bash
ls -la /opt/connectcomms/nginx/connect-api-upstream-active.conf*
sudo cp -a /opt/connectcomms/nginx/connect-api-upstream-active.conf.pre-<JOB_ID> \
  /opt/connectcomms/nginx/connect-api-upstream-active.conf
sudo nginx -t && sudo nginx -s reload
```

Use the job ID from the deploy log (`pre-manual` if `DEPLOY_JOB_ID` unset).

---

## Legacy mode (no nginx snippet)

If **`DEPLOY_API_BLUEGREEN=0`**, the script uses **`deploy_common_compose_up`** only — there is **no** upstream file. Rollback behavior is unchanged from older docs; fix the **`api`** service container and **`/health`** on **3001** as before.

---

## References

- Nginx install and env vars: `docs/nginx/README.md`
- Full deploy rules: `AGENTS.md`, `docs/safe-deploy-queue.md`
- Architecture and verification: `docs/ai-context/DEPLOYMENT.md` (blue/green section)
