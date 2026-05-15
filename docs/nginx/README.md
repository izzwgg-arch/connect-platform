# Nginx snippets for Connect (repo-owned templates)

Operators install these files on the **application host**, not inside git-tracked `/etc/nginx` in this repo. Agents do not edit production nginx per `AGENTS.md`; humans merge snippets into the server config.

## API blue/green (`connect_api_active`)

Purpose: **`scripts/deploy-api.sh`** switches the upstream between **`127.0.0.1:3001`** (stable service `api`) and **`127.0.0.1:3004`** (candidate **`api_candidate`**) **without** `docker compose rm -sf` on the live container before the replacement is ready.

### Install (one-time)

1. Create directory, e.g. **`/opt/connectcomms/nginx/`**.
2. Copy **`connect-api-upstream-active.snippet`** to **`/opt/connectcomms/nginx/connect-api-upstream-active.conf`** (or set **`DEPLOY_NGINX_API_UPSTREAM_ACTIVE_FILE`** to your path).
3. Add an **`upstream`** block using **`connect-api-upstream-include.example.conf`** as a guide.
4. **`nginx -t && nginx -s reload`**.

Ensure the UNIX user running deploy jobs **can rewrite** that include file (**`sudo`** is used for **`nginx -t`** / **`nginx -s reload`** when not root).

### Bootstrap from an empty machine

First API deploy after adding compose services can export:

- **`DEPLOY_API_UPSTREAM_BOOTSTRAP=1`** once so **`deploy-api.sh`** seeds the include file to **`127.0.0.1:3001`** and reloads nginx (requires snippet path writable or bootstrap will fail).

### Environment variables

| Variable | Meaning |
|---------|---------|
| **`DEPLOY_NGINX_API_UPSTREAM_ACTIVE_FILE`** | Path to the **single-line** `server 127.0.0.1:PORT;` file nginx includes. |
| **`DEPLOY_API_UPSTREAM_BOOTSTRAP`** | Set **`1`** once to create the include if missing (then unset). |
| **`DEPLOY_API_PUBLIC_VERIFY_URL`** | Optional full URL (e.g. public **`https://host/api/ready`**) verified after cutover. May need **`DEPLOY_API_PUBLIC_VERIFY_TLS_INSECURE=1`**. |
| **`DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL`** | Set **`1`** for **`https://`** verify URLs only: map the hostname to **`127.0.0.1:443`** with **`curl --resolve`** so the probe does not hairpin via the server's public IP (avoids nginx **403** on some origins). Same idea as portal **`DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL`**. |
| **`DEPLOY_API_PUBLIC_VERIFY_TLS_INSECURE`** | Set **`1`** to pass **`curl -k`** when verifying **`DEPLOY_API_PUBLIC_VERIFY_URL`**. |
| **`DEPLOY_API_BLUEGREEN`** | Set **`0`** to force legacy **`deploy_common_compose_up`** (**not** zero-downtime). |

---

## Portal blue/green (`connect_portal_active`)

Purpose: **`scripts/deploy-portal.sh`** switches the upstream for the **HTML Next.js app** between **`127.0.0.1:3000`** (**stable `portal`**) and **`127.0.0.1:3005`** (**`portal_candidate`**) **without** running **`docker compose rm -sf portal`** until user traffic already routes to **`portal_candidate`**.

**`location /api/`** stays on **`connect_api_active`** — do not collapse API and Portal into one upstream.

### Install (one-time)

1. Same directory as API, e.g. **`/opt/connectcomms/nginx/`**.
2. Copy **`connect-portal-upstream-active.snippet`** to **`connect-portal-upstream-active.conf`** (initial **`server 127.0.0.1:3000;`**), or set **`DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE`**.
3. Define **`upstream connect_portal_active { include …; }`** and set **`location /`** (and any same-app paths that should follow the portal container) to **`proxy_pass http://connect_portal_active;`**. See **`connect-portal-upstream-include.example.conf`**.
4. **`nginx -t && nginx -s reload`**.

The deploy user must be able to **rewrite** the portal include and run **`sudo -n nginx -t`** / **`reload`**.

### Bootstrap

- **`DEPLOY_PORTAL_UPSTREAM_BOOTSTRAP=1`** once if the include file is missing — seeds **`127.0.0.1:3000`** and reloads (then unset).

### Environment variables

| Variable | Meaning |
|---------|---------|
| **`DEPLOY_NGINX_PORTAL_UPSTREAM_ACTIVE_FILE`** | Single-line **`server 127.0.0.1:PORT;`** include for **`connect_portal_active`**. |
| **`DEPLOY_PORTAL_UPSTREAM_BOOTSTRAP`** | **`1`** once to create include if missing. |
| **`DEPLOY_PORTAL_PUBLIC_VERIFY_URL`** | Optional URL after cutovers (e.g. **`https://host/ready`**) — typically unset and rely on loopback **`/ready`** only. |
| **`DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL`** | **`1`** → for **`https://`** verify URLs only, map the hostname to **`127.0.0.1:443`** with **`curl --resolve`** so the probe does not hairpin via the server’s public IP (avoids nginx **403** on some origins). |
| **`DEPLOY_PORTAL_PUBLIC_VERIFY_TLS_INSECURE`** | **`1`** → **`curl -k`**. |
| **`DEPLOY_PORTAL_BLUEGREEN`** | **`0`** forces legacy **`deploy_common_compose_up`** on **`portal`** (**break-glass**). |
