# Asterisk REST Interface (ARI) setup for VitalPBX

The platform uses ARI to show **active calls** and **registered/unregistered endpoint counts** (PJSIP) on the dashboard and PBX page. Without ARI, those show "ARI not configured".

## 1. Enable ARI on your VitalPBX server

SSH into the VitalPBX server and edit Asterisk config.

### 1.1 Enable HTTP server (`http.conf`)

Create or edit `/etc/asterisk/http.conf`:

```ini
[general]
enabled = yes
bindaddr = 0.0.0.0
bindport = 8088
tlsenable = no
```

For production over the internet, use TLS (port 8089) and set `tlsenable = yes` with `tlscertfile` and `tlsprivatekey`.

### 1.2 Configure ARI user (`ari.conf`)

Create or edit `/etc/asterisk/ari.conf`:

```ini
[general]
enabled = yes
pretty = yes

[connect_platform]
type = user
read_only = yes
password = YOUR_SECURE_PASSWORD
```

- Use a strong password; the platform only does **read-only** GET requests (`/ari/channels`, `/ari/endpoints`).
- `read_only = yes` is recommended so the key cannot originate/hangup calls.

### 1.3 Restart Asterisk

```bash
asterisk -rx "core restart now"
# or
systemctl restart asterisk
```

### 1.4 Test ARI locally

```bash
curl -u connect_platform:YOUR_SECURE_PASSWORD http://127.0.0.1:8088/ari/channels
curl -u connect_platform:YOUR_SECURE_PASSWORD http://127.0.0.1:8088/ari/endpoints
```

You should get JSON (empty arrays if no calls / no PJSIP endpoints, or lists of objects).

## 2. Expose ARI to the platform (optional)

- If the Connect platform runs on the **same server** as VitalPBX, you can use `http://127.0.0.1:8088` as the ARI base URL.
- If the platform runs on a **different server**, expose port 8088 (or 8089 for HTTPS) via firewall and (if needed) reverse proxy. Use a **non‑public** URL or VPN so only the platform can reach it.

## 3. Configure the platform (API server)

Set these environment variables on the **API** server (e.g. in `.env` or Docker):

| Variable           | Required | Description |
|--------------------|----------|-------------|
| `PBX_ARI_USER`     | Yes      | ARI username (e.g. `connect_platform`) |
| `PBX_ARI_PASS`     | Yes      | ARI password from `ari.conf` |
| `PBX_ARI_BASE_URL` | No       | Base URL for ARI. Defaults to the same as the VitalPBX API (e.g. `https://m.connectcomunications.com`). Set only if ARI is on a different host/port. |

### Examples

**ARI on same host as VitalPBX API, same port (unusual):**
- No `PBX_ARI_BASE_URL`; ensure ARI is served at `https://m.connectcomunications.com/ari/...`.

**ARI on port 8088 (typical):**
- `PBX_ARI_BASE_URL=http://m.connectcomunications.com:8088`  
  or, if the API server is the same machine as VitalPBX:  
  `PBX_ARI_BASE_URL=http://127.0.0.1:8088`

**ARI with TLS on port 8089:**
- `PBX_ARI_BASE_URL=https://m.connectcomunications.com:8089`

After setting env vars, restart the API container/process. The dashboard and PBX page will then show:
- **Active Calls** (live)
- **Registered** / **Unregistered** PJSIP endpoint counts

## 4. Security

- Keep `PBX_ARI_USER` / `PBX_ARI_PASS` secret (env only, not in code).
- Prefer `read_only = yes` in `ari.conf`.
- Prefer TLS and restrict access (firewall/VPN) so only the platform can reach ARI.

## References

- [Asterisk Configuration for ARI](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Asterisk-Configuration-for-ARI/)
- [VitalPBX forum: ARI on Asterisk 20](https://forums.vitalpbx.org/t/ari-api-docs-returns-500-cannot-find-rest-api-directory-on-vitalpbx-asterisk-20-fix-with-symlink/5987)
