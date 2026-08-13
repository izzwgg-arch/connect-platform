# connect-prompt-sync installation

The Connect UI shows a ▶ Play button next to each VitalPBX System Recording
in IVR Routing → Route Profiles. For that button to actually play audio,
Connect needs the WAV/MP3/GSM bytes in its own storage. The
`connect-prompt-sync.sh` helper runs on the VitalPBX host (root cron) and
mirrors `/var/lib/asterisk/sounds/custom/*` into Connect on a schedule.

For admins who can't (or don't want to) install the cron helper, the same
upload endpoint is exposed through the Connect UI itself — pick a prompt in
the dropdown and hit **⇧ Upload** to push a WAV/MP3 directly from the
browser. The helper is only needed for *bulk* sync.

## Non-goals

- No per-call traffic to Connect. The helper only runs on cron.
- No SSH from Connect into the PBX.
- No file deletion on the PBX. `custom/` remains authoritative.

## One-time install on the PBX host

```bash
# 1. Copy the script
sudo install -m 0755 connect-prompt-sync.sh /usr/local/bin/connect-prompt-sync

# 2. Drop the shared secret (same value as MOH_SYNC_SHARED_SECRET on Connect)
sudo install -d -m 0700 /etc/connect
echo -n "<shared-secret>" | sudo tee /etc/connect/connect_media_secret > /dev/null
sudo chmod 0600 /etc/connect/connect_media_secret

# 3. Set the Connect URL in the environment file read by cron
sudo tee /etc/default/connect-prompt-sync > /dev/null <<'EOF'
CONNECT_URL=https://connect.example.com
SOUNDS_DIR=/var/lib/asterisk/sounds/custom
EOF

# 4. Schedule
echo '*/10 * * * * root . /etc/default/connect-prompt-sync && /usr/local/bin/connect-prompt-sync' \
  | sudo tee /etc/cron.d/connect-prompt-sync > /dev/null
sudo chmod 0644 /etc/cron.d/connect-prompt-sync
```

## Connect side (already set up if MOH sync works)

The helper reuses the existing shared secret env var:

```
PROMPT_SYNC_SHARED_SECRET=<shared-secret>   # optional; falls back to MOH_SYNC_SHARED_SECRET
MOH_SYNC_SHARED_SECRET=<shared-secret>      # already set if you run connect-media-sync
PROMPT_STORAGE_DIR=/data/ivr-prompts        # optional; defaults to ./data/ivr-prompts
```

In docker-compose / k8s the prompt storage directory should be a persistent
volume mounted into the API container. Example for the same compose file
that mounts MOH assets:

```yaml
services:
  api:
    volumes:
      - ivr-prompts:/app/data/ivr-prompts

volumes:
  ivr-prompts:
```

## Verifying the flow

```bash
# On the PBX host
sudo /usr/local/bin/connect-prompt-sync

# Watch the log
sudo tail -f /var/log/connect-prompt-sync.log
```

Then hit **Refresh catalog** in the Connect UI and confirm each prompt shows
a ▶ button next to its name. Playback streams via
`/voice/ivr/prompts/:id/stream?token=<jwt>` — one local-disk read per click,
no PBX involvement.
