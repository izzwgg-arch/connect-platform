# Connect Media Sync — PBX-host install guide

The `connect-media-sync.sh` helper is the **only** piece of Connect software
that runs on the VitalPBX / Asterisk host. It is responsible for mirroring
tenant-uploaded Music-On-Hold (MOH) audio from Connect onto the PBX's local
disk, then telling Asterisk to pick up the new files with `moh reload`.

It is a **pull** model: the helper reaches out on cron; Connect never opens an
SSH session or any inbound connection to the PBX. If the helper is stopped,
MOH stays exactly as it was — nothing breaks in-flight.

---

## 1. What you need

- A VitalPBX (Asterisk) host you can `sudo` on.
- `curl`, `jq`, `awk`, `flock`, `sha256sum` (all present on a default RHEL/CentOS
  VitalPBX image).
- A shared secret generated on the Connect side — any 32-byte random string.
  Set this on the Connect API as the environment variable
  `MOH_SYNC_SHARED_SECRET`.

---

## 2. Install the helper

```bash
# Copy the script
sudo install -m 0755 -o root -g root docs/pbx/connect-media-sync.sh \
    /usr/local/sbin/connect-media-sync

# Create the state + secret directories
sudo install -d -m 0750 -o root -g root /var/lib/connect-media-sync
sudo install -d -m 0700 -o root -g root /etc/connect

# Drop the shared secret (same value as MOH_SYNC_SHARED_SECRET on Connect)
sudo sh -c 'printf "REPLACE_ME_WITH_THE_SHARED_SECRET" > /etc/connect/connect_media_secret'
sudo chmod 0600 /etc/connect/connect_media_secret
```

### Configure the Connect URL

The helper reads two environment variables (or hard-codes at the top of the
script). The cleanest place to put them is
`/etc/default/connect-media-sync`:

```bash
CONNECT_URL=https://connect.yourdomain.com
# Optional: override paths. Defaults are production-safe.
# MOH_ROOT=/var/lib/asterisk/moh
# STATE_DIR=/var/lib/connect-media-sync
# SECRET_FILE=/etc/connect/connect_media_secret
# LOG_FILE=/var/log/connect-media-sync.log
```

Then make the cron job load it:

```cron
# /etc/cron.d/connect-media-sync
*/5 * * * * root . /etc/default/connect-media-sync; /usr/local/sbin/connect-media-sync >>/var/log/connect-media-sync.log 2>&1
```

Five-minute cadence is a good default. It's fast enough that operators never
feel "stuck" after uploading, and slow enough that the PBX sees no noticeable
CPU/IO load.

---

## 3. Verify

From the PBX host:

```bash
sudo /usr/local/sbin/connect-media-sync
ls -l /var/lib/asterisk/moh/ | grep connect_
sudo asterisk -rx "moh show classes" | head
```

You should see one `connect_<tenantslug>_<name>` directory per uploaded MOH
asset, each containing the `asset.<ext>` file and a short log in
`/var/log/connect-media-sync.log`.

---

## 4. Security notes

- Files are downloaded via short-lived (30 minute) HMAC-signed URLs. Leaking
  a signed URL to a third party gives them 30 minutes of read access to one
  audio file — nothing more.
- The helper NEVER writes outside `$MOH_ROOT`. Any manifest row attempting
  traversal (`..`, `/`) is logged and skipped.
- Delete-reconciliation is restricted to directories prefixed with
  `connect_`, so hand-maintained MOH classes on the same PBX are untouched.

---

## 5. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ERROR: manifest fetch failed` | Wrong `CONNECT_URL`, network egress blocked, or secret mismatch (401 on Connect) |
| `ERROR: sha256 mismatch` | In-flight tampering or the Connect storage bytes changed mid-download — safe to retry |
| `WARN: $ASTERISK_BIN not found` | Running outside Asterisk host or PATH missing; set `ASTERISK_BIN=/usr/sbin/asterisk` in `/etc/default/connect-media-sync` |
| `another sync run is in progress` | Expected if two cron runs overlap on a slow network. The second run exits cleanly. |

---

## 6. Uninstall

```bash
sudo rm -f /etc/cron.d/connect-media-sync
sudo rm -f /usr/local/sbin/connect-media-sync
sudo rm -rf /var/lib/connect-media-sync /etc/connect
# MOH audio is left in place — delete connect_* directories manually if desired.
```
