# Portal blue/green deploy — rollback runbook

> Use when **`scripts/deploy-portal.sh`** fails during **`DEPLOY_PORTAL_BLUEGREEN=1`** (default), or **`nginx`/container** state after a **`portal`** job is unclear.

**Do not** use manual **`docker compose up`** / **`git pull`** for production recovery except break-glass; prefer re-enqueue via the queue (**`AGENTS.md`**).

**Note (`commit_already_deployed`):** Same rule as **`api`**: only **real** (`dryRun: false`) successes for that **service** count toward the same-**`commitHash`** skip (**`deployed_commit`** or **`commit_hash`** fallback, **`connect-deploy-queue` 1.1.2+**). See **`DEPLOYMENT_API_ROLLBACK.md`**.

---

## Normal failure behavior (automated)

Readiness probes hit **`GET /ready`** (**`apps/portal/app/ready/route.ts`**) loopback-only on **`:3005`** then **`:3000`**, no JWT.

- **Candidate `/ready` never succeeds:** **`portal_candidate`** removed; **`nginx`** untouched; stable **`portal`** unchanged.
- **`nginx -t`/reload fails after flipping to `:3005`:** script restores **`active_port_before`** include + reload (**best effort**) + **`portal_candidate`** removed.
- **Stable recreate succeeds but `:3000` `/ready` fails:** **`nginx`** pointed back at **`:3005`** (if reload works); candidate may still hold traffic — fix stable stack or rollback below.
- **Reload fails normalizing back to `:3000`:** log warns traffic may remain on **`:3005`** until operator fixes **`nginx`/include.**

The deploy script clears **`trap ERR`** around rollout so rollout failure **does not** revert git blindly (matching **`deploy-api`** pattern).

---

## Check current state

1. Include file (**`DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE`** or **`/opt/connectcomms/nginx/connect-portal-upstream-active.conf`**):

   ```bash
   cat /opt/connectcomms/nginx/connect-portal-upstream-active.conf
   ```

   Expect **`server 127.0.0.1:3000;`** when normalized.

2. **Containers:**

   ```bash
   docker compose -f docker-compose.app.yml ps portal
   docker compose -f docker-compose.app.yml --profile portal_rollout ps portal_candidate
   ```

3. **Loopback readiness:**

   ```bash
   curl -fsS http://127.0.0.1:3000/ready || echo "stable not ready"
   curl -fsS http://127.0.0.1:3005/ready || echo "no candidate"
   ```

---

## Recover: traffic must be stable (3000)

If **`nginx`** still points at **`3005`** but stable listens on **`3000`**:

```bash
printf 'server 127.0.0.1:3000;\n' | sudo tee /opt/connectcomms/nginx/connect-portal-upstream-active.conf
sudo nginx -t && sudo nginx -s reload
docker compose -f docker-compose.app.yml --profile portal_rollout stop portal_candidate
docker compose -f docker-compose.app.yml --profile portal_rollout rm -sf portal_candidate
```

---

## Recover: enqueue previous known-good

After **`git`/clone** aligns with **`origin`**, enqueue **`portal`** on the last good SHA (**`commitHash`**), **`dryRun: true`** then real when green.

See **`DEPLOYMENT.md`** for portal blue/green and **`docs/nginx/README.md`** for include layout.
