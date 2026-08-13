# Smart-Home Phone IVR

Call a phone number, enter a PIN, press digits to control a smart home (lights, locks, thermostat — anything Home Assistant can reach).

## Architecture

This PBX build has no ARI WebSocket, so the IVR is implemented as a **FastAGI server** inside the telephony service on loopcom. The PBX's only involvement is one dialplan entry that hands the call to us; all logic, credentials, and smart-home traffic live on loopcom.

```
Caller → DID → VitalPBX/Asterisk (209.145.60.79)
                  dialplan: AGI(agi://45.14.194.179:4573)
                          │  (FastAGI over TCP — PBX is the client)
                          ▼
        telephony service on loopcom (apps/telephony, src/smarthome/)
          AgiServer → SmartHomeIvr (PIN auth → DTMF menu)
                          │ HTTPS + Bearer token
                          ▼
                 Home Assistant → lights, locks, thermostats, …
```

Call flow: answer → prompt for PIN (up to 3 attempts) → look up account by PIN → menu loop (digits 1–9 fire Home Assistant service calls, 0 repeats the prompt, `*` or silence ends the call) → confirmation prompt per action → goodbye.

## Configuration

Env vars (telephony service):

| Var | Default | Meaning |
|---|---|---|
| `SMARTHOME_IVR_ENABLED` | `false` | Master switch. Everything is inert when off. |
| `SMARTHOME_CONFIG_PATH` | — | Path to accounts/menu JSON (required when enabled). |
| `SMARTHOME_AGI_PORT` | `4573` | FastAGI listen port. |
| `SMARTHOME_AGI_BIND` | `0.0.0.0` | Bind address. |
| `SMARTHOME_AGI_ALLOWED_PEERS` | `PBX_HOST` | Comma-separated IPs allowed to open AGI sessions. |
| `SMARTHOME_HA_TIMEOUT_MS` | `5000` | Home Assistant HTTP timeout. |

Accounts file: see `apps/telephony/smarthome.example.json`. Each account holds a scrypt PIN hash, an optional Home Assistant base URL + long-lived access token, and a digit→action menu. PINs identify the account, so they must be unique. Generate a hash:

```bash
cd apps/telephony && tsx src/smarthome/hashPinCli.ts 4821
```

Prompts default to Asterisk core sounds (`vm-password`, `vm-incorrect`, `beep`, `auth-thankyou`, `sorry`, `vm-goodbye`) and are overridable per config — record custom prompts later (e.g. "Press 1 to turn the lights on…") and drop the names in the `prompts` block. Custom sound files must be installed on the **PBX** (they play from Asterisk), which is a PBX write — ask Izzy.

## Open integration model

Two layers keep this compatible with effectively any smart-home system, mainstream or open source:

1. **Home Assistant actions** (`domain`/`service`/`entityId`): Home Assistant has 2,000+ integrations — Hue, SmartThings, Tuya/Smart Life, Hubspace (Home Depot brands, via HACS), Nest, Ring, Ecobee, Matter, HomeKit, plus open-source ecosystems (Zigbee2MQTT, ESPHome, Tasmota, Z-Wave JS). Adding a device is config-only: integrate it in HA, map a digit.
2. **Webhook actions** (`webhook`: url/method/headers/body): a menu digit can fire any HTTP API directly — openHAB, Node-RED flows, SmartThings REST, home-grown services — for anything HA doesn't cover. Same timeout/error handling and confirmation prompts as HA actions. Accounts using only webhooks don't need an `ha` section at all.

## Security model

The PIN is the authentication; caller ID is never trusted (it is spoofable) and is only used to *restrict*: max 3 PIN attempts per call, per-caller lockout (5 failures / 15 min) plus a global lockout window (20 failures / 15 min) to stop rotating-caller-ID brute force. PIN hashes are scrypt; HA tokens live only in the config file on loopcom (keep it mode 600, outside git). The AGI listener accepts connections only from `SMARTHOME_AGI_ALLOWED_PEERS` (the PBX). Prefer keeping Home Assistant reachable via WireGuard/VPN rather than exposed to the internet.

## Verification

- Unit tests (24): `pnpm --filter @connect/telephony test` (suite total 129 — all passing as of 2026-07-19).
- Local end-to-end without a PBX: `tsx src/smarthome/e2eLocal.ts` — boots the real module, mocks Asterisk and Home Assistant, verifies PIN → digit → HA call → prompts.

## Rollout steps

1. Home Assistant: create a long-lived access token (Profile → Security), note base URL; ensure loopcom can reach it (WireGuard preferred).
2. On loopcom: create `/opt/connectcomms/env/smarthome.json` from the example, `chmod 600`, set `SMARTHOME_IVR_ENABLED=true` and `SMARTHOME_CONFIG_PATH` in the telephony env.
3. Deploy the telephony service **via the deploy queue** (target `telephony`). Never restart manually.
4. **PBX (requires Izzy's approval — PBX is read-only for agents):** pick a DID/extension and route it to a custom dialplan entry:

   ```
   exten => _X.,1,AGI(agi://45.14.194.179:4573)
    same => n,Hangup()
   ```

   In VitalPBX: Custom Contexts / Custom Applications → point the DID or an internal extension at the AGI. Also open TCP 4573 from PBX→loopcom if a firewall sits between them.
5. Call the number, enter the PIN, press 1. Watch `connect_smarthome_ivr_*` metrics and the `SmartHomeIvr` log component.

## Files

- `apps/telephony/src/smarthome/` — module (`agi/` FastAGI server + protocol, `SmartHomeIvr.ts` flow, `HomeAssistantClient.ts`, `config.ts`, `pinHash.ts`, `pinLockout.ts`, `e2eLocal.ts`, `hashPinCli.ts`)
- `apps/telephony/smarthome.example.json` — config template
- Wiring: `src/server.ts` (flag-gated start), `src/config/env.ts`, `src/metrics/index.ts`
