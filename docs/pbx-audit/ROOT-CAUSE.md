# PBX Audit Script — Root Cause Analysis

**PBX:** 209.145.60.79  
**Account:** `cursor-audit` (SSH forced-command only, no shell)  
**Observed:** ACTIVE CHANNELS / ACTIVE CHANNEL COUNT / ACTIVE BRIDGES all report "Asterisk command failed" or "Could not get bridges"; LAST ASTERISK LOGS and system load/memory work.

---

## 1. What We Know

- SSH runs a **single forced command** (no shell). We cannot run `cat /usr/local/bin/pbx_audit_snapshot` or inspect `/etc/sudoers.d/cursor-audit` from this session.
- The script **does run**: we get the header, time, section labels, system load, memory, and Asterisk log tail.
- **Only the Asterisk CLI invocations fail** — the script prints "Asterisk command failed", "Could not get active channel count", "Could not get bridges".
- Log tail works → something (e.g. `tail /var/log/asterisk/full`) is allowed and succeeds; Asterisk CLI does not.

---

## 2. Most Likely Causes (in order)

### A. Script does not use `sudo` for Asterisk

- On typical VitalPBX/Asterisk, only `root` (or sometimes user `asterisk`) can run `asterisk -rx "..."`. If the script runs `asterisk -rx "core show channels"` without `sudo`, it will fail (permission denied or “command not found” if `asterisk` is not in PATH for the SSH-forced environment).

**Minimum change:** Run every Asterisk CLI command via `sudo`, e.g.  
`sudo /usr/sbin/asterisk -rx "core show channels"`.

### B. Script uses `asterisk` without full path

- Forced-command SSH often has a **minimal environment** (no or limited PATH). If the script runs `asterisk` or `sudo asterisk`, the binary may not be found.

**Minimum change:** Use full path: `/usr/sbin/asterisk` (confirm on server with `which asterisk` or `command -v asterisk` from a privileged session).

### C. Sudoers does not allow the Asterisk commands

- If the script does `sudo /usr/sbin/asterisk -rx "core show version"` but sudoers has no matching rule (or a rule that doesn’t match the exact command/arguments), sudo will deny the command.

**Minimum change:** Add a sudoers fragment under `/etc/sudoers.d/` that allows `cursor-audit` to run only the required read-only commands, e.g.:
  - `sudo /usr/sbin/asterisk -rx "core show version"`
  - `sudo /usr/sbin/asterisk -rx "core show channels"`
  - … (and the other approved commands)
  - `sudo /usr/bin/tail -n 100 /var/log/asterisk/full`

  Use **exact command paths** and, if your sudoers uses argument matching, ensure the rules match how the script invokes the commands (with or without quotes as appropriate).

### D. Sudoers argument matching / quoting

- Some sudoers configurations allow only a specific command with no arguments, or match arguments in a way that fails when the script passes `-rx "core show channels"` (e.g. spaces or quotes).

**Minimum change:** In the sudoers fragment, allow each full command as it will be run (same path, same arguments). Avoid over‑broad wildcards; keep the list to the exact read-only audit commands.

### E. `requiretty` or `!requiretty`

- If `Defaults requiretty` is set and the forced-command SSH has no TTY, sudo might refuse to run.

**Minimum change:** In `/etc/sudoers.d/cursor-audit` add `Defaults:cursor-audit !requiretty` so that user `cursor-audit` can run sudo non-interactively.

### F. Wrong script or wrong command name

- The forced command might point at a script that doesn’t match the one that was updated, or the script might call a different binary (e.g. `asterisk` vs `/usr/sbin/asterisk`).

**Minimum change:** Ensure `authorized_keys` forces the correct script (e.g. `/usr/local/bin/pbx_audit_snapshot`) and that the script uses the same paths as in the sudoers file.

---

## 3. Exact Failing “Lines” (inferred)

We cannot see the script source from read-only SSH. The **logical** failing steps are those that run Asterisk CLI:

- Whatever line runs “core show channels” (or equivalent) → produces “Asterisk command failed” and “Could not get active channel count”.
- Whatever line runs “bridge show all” (or equivalent) → produces “Could not get bridges”.

So the **exact reason** Asterisk CLI is failing is one of (A)–(F) above: either the script doesn’t run Asterisk with sudo/full path, or sudoers doesn’t allow it, or TTY/quoting/argument matching blocks it.

---

## 4. Minimum Change Needed

1. **On the PBX (privileged session):**
   - Confirm Asterisk path: `which asterisk` or `ls -l /usr/sbin/asterisk`.
   - Replace (or fix) the audit script so it **only** runs the approved read-only commands using:
     - `sudo /usr/sbin/asterisk -rx "..."` for every Asterisk CLI command.
     - `sudo /usr/bin/tail -n 100 /var/log/asterisk/full` for the log tail.
   - Install a sudoers fragment under `/etc/sudoers.d/` (e.g. `cursor-audit`) that:
     - Sets `Defaults:cursor-audit !requiretty`.
     - Allows only the exact list of commands above (full paths, no extra privileges).
   - Ensure the script is executable and that the SSH forced command in `authorized_keys` invokes this script (no shell, no forwarding).

2. **No other changes:** Do not modify dialplan, routes, trunks, queues, IVRs, AMI, ARI, or any PBX config; do not grant shell or broader privileges.

---

## 5. How to Confirm Root Cause (for PBX admin)

From a **privileged** login on 209.145.60.79:

```bash
# Asterisk binary
which asterisk
command -v asterisk
ls -l /usr/sbin/asterisk

# Script content
cat /usr/local/bin/pbx_audit_snapshot

# Sudoers
sudo cat /etc/sudoers.d/cursor-audit

# Test as cursor-audit (simulate forced-command environment)
sudo -u cursor-audit env -i PATH=/usr/bin:/bin /usr/local/bin/pbx_audit_snapshot
```

If the last command prints real channel/bridge output, the fix is correct. If it still fails, the output of that run (and the script + sudoers contents) will show the exact failing line and reason.
