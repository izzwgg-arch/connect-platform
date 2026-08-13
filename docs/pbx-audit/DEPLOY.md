# Deploy Read-Only PBX Audit Fix

Apply these steps on **209.145.60.79** from a **privileged** (root or sudo) session. Do not change dialplan, routes, trunks, queues, IVRs, AMI, ARI, or grant shell access.

---

## 1. Confirm Asterisk path

```bash
which asterisk
# or
command -v asterisk
ls -l /usr/sbin/asterisk
```

If Asterisk is elsewhere (e.g. `/usr/bin/asterisk`), replace `/usr/sbin/asterisk` in both the script and the sudoers fragment with that path.

---

## 2. Install the audit script

- Copy `pbx_audit_snapshot.sh` from this repo to `/usr/local/bin/pbx_audit_snapshot`.
- Ensure ownership and permissions:

```bash
sudo cp pbx_audit_snapshot.sh /usr/local/bin/pbx_audit_snapshot
sudo chown root:root /usr/local/bin/pbx_audit_snapshot
sudo chmod 755 /usr/local/bin/pbx_audit_snapshot
```

If your Asterisk path is not `/usr/sbin/asterisk`, edit the script and set `ASTERISK=` to the correct path.

---

## 3. Install the sudoers fragment

- Copy `sudoers.d-cursor-audit` to `/etc/sudoers.d/cursor-audit`.
- Set permissions (must be 440 and root-owned):

```bash
sudo cp sudoers.d-cursor-audit /etc/sudoers.d/cursor-audit
sudo chown root:root /etc/sudoers.d/cursor-audit
sudo chmod 440 /etc/sudoers.d/cursor-audit
```

- Validate sudoers:

```bash
sudo visudo -c -f /etc/sudoers.d/cursor-audit
```

If you changed the Asterisk path in the script, use the same path in the sudoers file.

---

## 4. Ensure SSH forced command

In `/home/cursor-audit/.ssh/authorized_keys`, the key line should force the script and **no shell**:

```
command="/usr/local/bin/pbx_audit_snapshot",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <KEY>
```

Do **not** add a shell or allow PTY.

---

## 5. Test from the server (as cursor-audit)

Simulate the forced-command environment:

```bash
sudo -u cursor-audit env -i PATH=/usr/bin:/bin /usr/local/bin/pbx_audit_snapshot
```

You should see real Asterisk output in:

- **CORE SHOW VERSION**
- **ACTIVE CHANNELS** (and **ACTIVE CHANNELS CONCISE**)
- **ACTIVE BRIDGES**
- **PJSIP SHOW CHANNELS** / **QUEUE SHOW** / **PJSIP SHOW ENDPOINTS**
- **LAST ASTERISK LOGS**

If any section still shows "Asterisk command failed" or "Could not get bridges", check:

- Asterisk path (step 1) and that it’s used in both script and sudoers.
- `sudo -l -U cursor-audit` to confirm the allowed commands.
- `Defaults:cursor-audit !requiretty` in the sudoers fragment.

---

## 6. Verify from your workstation

After deploy, run:

```bash
ssh -o BatchMode=yes cursor-audit@209.145.60.79
```

**Success:** Output includes real channel lists, bridge list, and counts (not "Asterisk command failed" / "Could not get bridges").

**Then:** Proceed with the forensic comparison cycle (same-moment PBX snapshot + dashboard KPI + GET /forensic + GET /diagnostics).
