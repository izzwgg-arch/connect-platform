# ConnectComms Telephony Service

Standalone Node.js service that connects the ConnectComms backend to VitalPBX/Asterisk
and exposes a normalized, real-time telephony event stream to the frontend.

---

## What this service does

1. Connects to **Asterisk AMI** (TCP port 5038) on the PBX server for live event ingestion.
2. Connects to **Asterisk ARI** (HTTP/WS port 8088) on the PBX server for call-control actions.
3. Maintains an **in-memory call state engine** — correlates multi-leg calls, tracks direction/state/queue/extension presence.
4. Exposes a **WebSocket stream** (`/ws/telephony`) to the ConnectComms frontend with normalized events.
5. Exposes **REST endpoints** for health checks, snapshots, and actions.

**The frontend never connects to AMI or ARI directly. All PBX interfaces are internal to this service.**

---

## Architecture

```
PBX server (209.145.60.79)           ConnectComms server (45.14.194.179)
┌───────────────────────┐            ┌────────────────────────────────────────┐
│  Asterisk AMI :5038   │◄──TCP──────│  AmiClient (reconnect + frame parser)  │
│  Asterisk ARI :8088   │◄──HTTP/WS──│  AriClient (REST + WebSocket events)   │
└───────────────────────┘            │                                        │
                                     │  TelephonyService (event → state)      │
                                     │  CallStateStore                        │
                                     │  ExtensionStateStore                   │
                                     │  QueueStateStore                       │
                                     │                                        │
                                     │  TelephonySocketServer (:3003/ws/tel.) │◄── frontend
                                     │  REST API (:3003)                      │◄── portal API
                                     └────────────────────────────────────────┘
```

### AMI vs ARI

| | AMI | ARI |
|---|---|---|
| Role | **Primary** event source | **Secondary** — call control only |
| Protocol | TCP text frames (port 5038) | HTTP REST + WebSocket (port 8088) |
| Used for | All monitoring, state tracking | hangup, originate, bridge, transfer |
| Frontend? | Never | Never |

---

## Configuration

Copy `.env.example` to `.env` and fill in secrets:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `3003` | HTTP/WS listen port |
| `NODE_ENV` | no | `production` | `development` enables pino-pretty |
| `LOG_LEVEL` | no | `info` | pino log level |
| `JWT_SECRET` | **yes** | — | Shared JWT secret with the API server |
| `PBX_HOST` | no | `209.145.60.79` | PBX server IP |
| `AMI_PORT` | no | `5038` | AMI TCP port |
| `AMI_USERNAME` | **yes** | — | AMI manager user |
| `AMI_PASSWORD` | **yes** | — | AMI manager secret |
| `ARI_BASE_URL` | **yes** | — | e.g. `http://209.145.60.79:8088` |
| `ARI_USERNAME` | **yes** | — | ARI HTTP user |
| `ARI_PASSWORD` | **yes** | — | ARI HTTP password |
| `ARI_APP_NAME` | no | `connectcomms` | Stasis app name |
| `TELEPHONY_WS_PATH` | no | `/ws/telephony` | WebSocket mount path |
| `TELEPHONY_SNAPSHOT_INTERVAL_MS` | no | `5000` | Health broadcast interval |
| `TELEPHONY_EVENT_DEBOUNCE_MS` | no | `100` | Event debounce window |
| `ENABLE_TELEPHONY_DEBUG` | no | `false` | Log every raw AMI frame |

---

## How to run

```bash
# Development (tsx watch)
pnpm --filter @connect/telephony dev

# Type-check
pnpm --filter @connect/telephony typecheck

# Smoke test (service must be running)
pnpm --filter @connect/telephony smoke
```

In Docker:
```bash
docker compose -f docker-compose.app.yml up telephony
```

---

## REST endpoints

All telephony endpoints require a JWT (`Authorization: Bearer <token>` or `?token=`).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Service + connection health |
| GET | `/telephony/health` | JWT | Full health detail |
| GET | `/telephony/snapshot` | JWT | Full state snapshot |
| GET | `/telephony/calls` | JWT | Active calls |
| GET | `/telephony/extensions` | JWT | Extension presence |
| GET | `/telephony/queues` | JWT | Queue state |
| POST | `/telephony/calls/originate` | JWT | Originate a call via AMI |
| DELETE | `/telephony/calls/:channelId/hangup` | JWT | Hang up a channel |
| POST | `/telephony/calls/:channelId/transfer` | JWT | Blind transfer a channel |

---

## WebSocket events

Connect to `ws://host:3003/ws/telephony?token=<jwt>`.

On connect you receive an immediate `telephony.snapshot`.

| Event name | Payload | Description |
|---|---|---|
| `telephony.snapshot` | `TelephonySnapshot` | Full state dump (on connect) |
| `telephony.call.upsert` | `NormalizedCall` | Call created or updated |
| `telephony.call.remove` | `{ callId }` | Call evicted after hangup |
| `telephony.extension.upsert` | `NormalizedExtensionState` | Extension presence update |
| `telephony.queue.upsert` | `NormalizedQueueState` | Queue member/caller update |
| `telephony.health` | `TelephonyHealth` | Periodic health heartbeat |

---

## Firewall requirements

```
45.14.194.179 → 209.145.60.79:5038  TCP (AMI)
45.14.194.179 → 209.145.60.79:8088  TCP (ARI HTTP + WebSocket)
```

Frontend (any IP) → 45.14.194.179:3003  TCP (this service only)

---

## TODO — advanced features

- **Whisper / barge**: requires ARI snoop channel (`/ari/channels/{id}/snoop`). Do not enable without a compliance and ACL review on the VitalPBX dialplan.
- **Recording**: ARI `/ari/channels/{id}/record` stores files on the PBX. Mirror path to app before enabling.
- **Tenant mapping**: `TenantResolver` currently uses PJSIP `@domain` and context prefix strategies. Add a VitalPBX API polling strategy in `src/telephony/state/TenantResolver.ts` using `/api/v2/tenants` for a full context→tenantId map.
- **PostgreSQL persistence**: Add a repository layer that writes call CDR rows from `CallStateStore` `callRemove` events. Interface is ready in the state stores.
- **Redis pub/sub**: Replace in-process EventEmitter with a Redis pub/sub adapter if running multiple telephony replicas.
