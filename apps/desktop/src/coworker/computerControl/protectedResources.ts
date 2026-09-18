/**
 * Cross-tool resource policy — the same answer whichever tool asks.
 *
 * ⛔ THE RULE (Izzy's brief, 2026-09-18, "CROSS-TOOL POLICY"): if the file tool
 * may not read `secret.txt`, then PowerShell `Get-Content secret.txt` may not,
 * opening it in Notepad through UI Automation may not, and uploading it from the
 * browser may not. Policy is about the RESOURCE and the INTENT, never the tool
 * name. So the lists live here once and every layer calls in:
 *
 *   - `isProtectedPath(p)`         the file tools, open_path, UIA launch args,
 *                                   browser upload, the PowerShell path scan
 *   - `scriptTouchesProtected(s)`   PowerShell — credential stores, secret files,
 *                                   DPAPI, LSASS, the Loopcom app's own data
 *   - `classifyShellScript(s)`      READ_ONLY / MODIFY / HIGH_RISK — the shell
 *                                   tool's risk is decided from the script, and a
 *                                   read-only classification is STRICT (allowlist
 *                                   of verbs, no redirection, no method calls that
 *                                   could mutate, no `&`/`.`/iex)
 *   - `scriptPathLiterals(s)`       absolute Windows paths found in a script, so
 *                                   the runtime can fence them exactly like a file
 *                                   tool argument
 *
 * ⛔ Pure. No fs, no Electron. Everything here is unit-tested and stress-tested;
 * nothing here may "probably" be safe. A wrong "protected" costs a refusal the
 * person can read; a wrong "fine" hands the model a password store.
 */

/* ───────────────────────── protected paths ───────────────────────── */

/**
 * Segments (lower-case, forward slashes) that mark a secret store. Matched
 * anywhere in the normalized path. Kept deliberately broad: browsers' credential
 * databases, Windows' credential/DPAPI vaults, SSH/GPG/cloud keys, and the Loopcom
 * app's own storage (its session token lives there).
 */
const PROTECTED_SEGMENTS: readonly string[] = [
  // Windows credential & DPAPI stores
  "/appdata/local/microsoft/credentials",
  "/appdata/roaming/microsoft/credentials",
  "/appdata/roaming/microsoft/protect",
  "/appdata/local/microsoft/vault",
  "/appdata/roaming/microsoft/vault",
  "/appdata/local/microsoft/tokenbroker",
  "/appdata/local/microsoft/identitycache",
  "/appdata/local/microsoft/onedrive/settings",
  "/appdata/local/packages/microsoft.aad.brokerplugin",
  // browsers' saved passwords / cookies / session stores
  "/appdata/local/google/chrome/user data",
  "/appdata/local/chromium/user data",
  "/appdata/local/microsoft/edge/user data",
  "/appdata/local/bravesoftware/brave-browser/user data",
  "/appdata/roaming/opera software",
  "/appdata/local/vivaldi/user data",
  "/appdata/roaming/mozilla/firefox/profiles",
  // keys
  "/.ssh",
  "/.gnupg",
  "/.aws",
  "/.azure",
  "/.config/gcloud",
  "/.kube",
  "/.docker/config.json",
  // credential files apps keep in the home folder
  "/.git-credentials",
  "/.netrc",
  "/_netrc",
  "/.npmrc",
  "/.pypirc",
  // VS Code / editors' secret storage
  "/appdata/roaming/code/user/globalstorage",
  "/appdata/roaming/cursor/user/globalstorage",
  // password managers
  "/appdata/local/1password",
  "/appdata/roaming/keepass",
  "/appdata/local/bitwarden",
  "/appdata/roaming/bitwarden",
  // Loopcom's own app data (session token, machine keys, remote-desktop secrets)
  "/appdata/roaming/@connect",
  "/appdata/roaming/loopcom support",
  "/appdata/local/programs/@connectdesktop",
  "/appdata/local/@connectdesktop-updater",
];

/** File names that are secrets wherever they are. */
const PROTECTED_BASENAMES: readonly RegExp[] = [
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|ppk|pfx|p12|key|keystore|jks|kdbx|kdb|asc|gpg)$/i,
  /^(?:login data|cookies|web data|local state|key4\.db|logins\.json|cert9\.db|signons\.sqlite)$/i,
  /^(?:credentials|\.credentials|token\.json|refresh_token|access_token|master\.key|secring\.gpg|pubring\.kbx)$/i,
  /^ntds\.dit$/i,
  /^(?:sam|system|security)$/i, // registry hives when found under config
];

/** Forward slashes, lower-case, no trailing slash. Never resolves `..` (the caller's fence does). */
export function normalizeForPolicy(p: string): string {
  return String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export type ProtectedVerdict = { protected: false } | { protected: true; reason: string; segment: string };

export function isProtectedPath(input: unknown): ProtectedVerdict {
  if (typeof input !== "string" || !input.trim()) return { protected: false };
  const p = normalizeForPolicy(input);
  const withLead = p.startsWith("/") || /^[a-z]:/.test(p) ? p : `/${p}`;
  for (const seg of PROTECTED_SEGMENTS) {
    // segment match: "…/x/.ssh" or "…/x/.ssh/…", never "…/.sshfoo"
    const idx = withLead.indexOf(seg);
    if (idx >= 0) {
      const end = idx + seg.length;
      if (end === withLead.length || withLead[end] === "/") return { protected: true, reason: "credential_store", segment: seg };
    }
  }
  const base = withLead.slice(withLead.lastIndexOf("/") + 1);
  for (const re of PROTECTED_BASENAMES) {
    if (re.test(base)) {
      // registry hive names only count under a config directory
      if (/^(?:sam|system|security)$/i.test(base) && !/\/config\/(?:sam|system|security)$/.test(withLead)) continue;
      return { protected: true, reason: "secret_file", segment: base };
    }
  }
  return { protected: false };
}

/* ───────────────────────── protected commands ───────────────────────── */

/**
 * Command shapes that read or export secrets, whatever the profile. Distinct
 * from the shell DENYLIST (which is about changing the machine's security
 * posture): these are about EXFILTRATING what the person's account can reach.
 */
export const PROTECTED_COMMAND_PATTERNS: readonly { id: string; re: RegExp; why: string }[] = [
  { id: "credential_manager", re: /\bcmdkey\b|\bvaultcmd\b|\bGet-StoredCredential\b|\bCredEnumerate\w*\b|\bCredRead\w*\b|\bkeymgr\.dll\b|\bCredentialManager\b/i, why: "reads the Windows Credential Manager" },
  { id: "dpapi", re: /\bCryptUnprotectData\b|\bProtectedData\]::Unprotect\b|\bDPAPI\b|\bMasterKeys?\b/i, why: "decrypts protected (DPAPI) secrets" },
  { id: "lsass", re: /\blsass\b|\bprocdump\b|\bMiniDump\w*\b|\bsekurlsa\b|\bmimikatz\b|\bcomsvcs\.dll\b/i, why: "touches the Windows logon process memory" },
  { id: "hives", re: /\breg(?:\.exe)?\s+(?:save|export)\s+HK(?:LM|EY_LOCAL_MACHINE)\\(?:SAM|SYSTEM|SECURITY)\b|\bntds\.dit\b|\bHKLM:\\SAM\b|\bHKLM:\\SECURITY\b/i, why: "exports the Windows account database" },
  { id: "wifi_keys", re: /\bnetsh\s+wlan\s+show\s+profiles?\b[^\n]*key\s*=\s*clear/i, why: "reveals saved Wi‑Fi passwords" },
  { id: "certificates", re: /\bExport-PfxCertificate\b|\bcertutil(?:\.exe)?\s+-exportPFX\b|\bcertutil(?:\.exe)?\s+-store\b[^\n]*-p\b/i, why: "exports private certificates" },
  { id: "browser_secrets", re: /\b(?:Login Data|Web Data|key4\.db|logins\.json|signons\.sqlite)\b/i, why: "reads the browser's saved passwords" },
  { id: "clipboard_secret", re: /\bGet-Clipboard\b[^\n]*(?:password|token|secret)/i, why: "reads a secret from the clipboard" },
  { id: "loopcom_own", re: /@connect\\desktop|@connect\/desktop|Loopcom Support\\|\bconnect2_ed25519\b|\.connect-ssh\b/i, why: "reads the Loopcom app's own private data" },
  { id: "env_secrets", re: /\$env:(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|PRIVATE_?KEY)[A-Z_]*)\b/i, why: "reads a secret from an environment variable" },
];

export function scriptTouchesProtected(script: string): { ok: true } | { ok: false; error: string; message: string } {
  if (typeof script !== "string") return { ok: true };
  for (const p of PROTECTED_COMMAND_PATTERNS) {
    if (p.re.test(script)) return { ok: false, error: `protected_resource:${p.id}`, message: `The Coworker will not run this because it ${p.why}. Secrets are never read on the person's behalf, whichever tool would do it.` };
  }
  for (const lit of scriptPathLiterals(script)) {
    const v = isProtectedPath(lit);
    if (v.protected) return { ok: false, error: `protected_resource:${v.reason}`, message: `The Coworker will not touch ${lit} — it is a place where passwords or keys are kept, and that is refused for every tool, not just PowerShell.` };
  }
  return { ok: true };
}

/**
 * Absolute Windows paths mentioned in a script (C:\..., \\server\share, ~/...,
 * $env:USERPROFILE\..., $HOME\...). Quoted or bare. Used by the runtime to apply
 * the SAME root fence a file-tool argument gets.
 */
export function scriptPathLiterals(script: string): string[] {
  if (typeof script !== "string" || !script) return [];
  const out = new Set<string>();
  const re = /(?:[A-Za-z]:[\\/]|\\\\[^\s"'`,;)]+[\\/]|\$(?:env:(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|TEMP|TMP|ProgramData|ProgramFiles(?:\(x86\))?|SystemRoot|windir)|HOME|PSScriptRoot)[\\/]|~[\\/])[^\s"'`,;)|<>*?]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const raw = m[0].replace(/[.:]+$/, "");
    if (raw.length > 2) out.add(raw);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return [...out];
}

/* ───────────────────────── shell classification ───────────────────────── */

export type ShellClass = "READ_ONLY" | "MODIFY" | "HIGH_RISK";

/** Verbs whose cmdlets only observe. `Get-Content` reads a file, so path fencing still applies (the runtime does it). */
const READ_ONLY_VERBS = new Set(["get", "test", "measure", "select", "where", "sort", "format", "convertto", "convertfrom", "resolve", "find", "search", "show", "read", "compare", "group", "out", "write", "foreach", "tee", "join", "split", "confirm", "trace", "export"]);
/** Even among read-only verbs, these particular cmdlets are not read-only or leak secrets. */
const READ_ONLY_EXCEPTIONS = /\b(?:Get-Credential|Get-Clipboard|Read-Host|Export-PfxCertificate|Export-Certificate|Export-Clixml|Out-File|Export-Csv|Export-Json|Write-Host\s+-NoNewline\s*$|Tee-Object|Test-NetConnection\s+[^\n]*-Port\s+\d+\s+[^\n]*-Count\s+\d{3,})\b/i;
/** Method calls a read-only script may make (string/collection helpers). Anything else → MODIFY. */
const SAFE_METHODS = /^(?:tostring|trim|trimstart|trimend|split|contains|startswith|endswith|replace|substring|tolower|toupper|padleft|padright|indexof|lastindexof|length|count|tochararray|join|keys|values|getvalue|tojson|equals|compareto|getenumerator|getproperties|getfiles|getdirectories|getname|totalseconds|totalminutes|totalhours|totaldays|totalmilliseconds|addseconds|addminutes|adddays|addhours|tolocaltime|touniversaltime|round|floor|ceiling|max|min|abs|isnullorempty|isnullorwhitespace|concat|format|getbytes|getstring|tolist|toarray|first|last|any|select|where|gettype|readalltext|readalllines|exists|getfilename|getextension|getdirectoryname|combine|getfullpath)$/i;

const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /\bInvoke-Expression\b|\biex\b/i,
  /\bInvoke-WebRequest\b[^\n]*\|\s*(?:iex|Invoke-Expression)/i,
  /\bStart-Process\b[^\n]*-Verb\s+RunAs\b/i,
  /\bRemove-Item\b[^\n]*-Recurse\b|\brmdir\s+\/s\b|\brd\s+\/s\b|\bdel\s+\/[sq]\b/i,
  /\bFormat-Volume\b|\bdiskpart\b|\bbcdedit\b/i,
  /\bSet-ItemProperty\b[^\n]*HKLM|\bNew-ItemProperty\b[^\n]*HKLM|\breg(?:\.exe)?\s+(?:add|delete)\b/i,
  /\bschtasks\b[^\n]*\/create|\bRegister-ScheduledTask\b|\bNew-ScheduledTask\b/i,
  /\bStop-Process\b[^\n]*-Name\s+(?:\*|csrss|winlogon|lsass|svchost|explorer|Loopcom)\b|\btaskkill\b[^\n]*\/im\s+(?:csrss|winlogon|lsass|svchost|explorer|Loopcom)/i,
  /\bInvoke-Command\b[^\n]*-ComputerName\b|\bEnter-PSSession\b|\bNew-PSSession\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /\bAdd-Type\b[^\n]*(?:DllImport|kernel32|ntdll|advapi32)/i,
  /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b[^\n]*-(?:OutFile|Destination)\b[^\n]*\.(?:exe|msi|ps1|bat|cmd|vbs|js|scr|dll)\b/i,
  /\bcipher(?:\.exe)?\s+\/w\b|\bsdelete\b/i,
  /\bwevtutil\s+cl\b|\bClear-EventLog\b/i,
  /\bStop-Process\b[^\n]*-Force\b/i,
];

export type ShellClassification = { class: ShellClass; reasons: string[] };

/**
 * Decide the risk of a script from its text. READ_ONLY is a STRICT allowlist:
 * one wrong "read-only" would let a mutating script run without the ask the
 * profile requires, so anything the classifier cannot vouch for is MODIFY.
 */
export function classifyShellScript(script: string): ShellClassification {
  const s = typeof script === "string" ? script : "";
  const reasons: string[] = [];
  for (const re of HIGH_RISK_PATTERNS) if (re.test(s)) reasons.push(`high_risk:${re.source.slice(0, 40)}`);
  if (reasons.length) return { class: "HIGH_RISK", reasons };

  // Anything below disqualifies READ_ONLY (→ MODIFY).
  const stripped = stripStringsAndComments(s);
  if (/[^|<>]>[^>]|>>|\|\s*out-file|\|\s*set-content|\|\s*add-content|\|\s*export-/i.test(stripped)) reasons.push("redirection_or_write");
  if (/(^|[\s;(])[&.]\s*(?:[$"'(_.\\]|[A-Za-z])/m.test(stripped)) reasons.push("call_operator_or_dot_source");
  if (/\[[A-Za-z0-9_.]+\]::[A-Za-z_]+\s*\(/.test(stripped) && !/\[(?:math|string|datetime|timespan|int|double|decimal|uri|convert|system\.text\.encoding|environment|io\.path|io\.file|io\.directory|char|regex|version|guid|bitconverter|system\.io\.path|system\.io\.file|system\.io\.directory)\]::(?:round|floor|ceiling|max|min|abs|pow|sqrt|isnullorempty|isnullorwhitespace|join|concat|format|now|utcnow|parse|tryparse|fromseconds|fromminutes|frommilliseconds|getfolderpath|getenvironmentvariable|machinename|username|osversion|is64bitoperatingsystem|processorcount|tickcount|combine|getfilename|getextension|getdirectoryname|getfullpath|exists|readalltext|readalllines|getfiles|getdirectories|tostring|escape|unescape|match|matches|replace|newguid|tobase64string|frombase64string|getstring|getbytes|toint32|todouble|tostring|toboolean)\s*\(/i.test(stripped)) reasons.push("static_method_call");
  const methodRe = /\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let mm: RegExpExecArray | null;
  while ((mm = methodRe.exec(stripped)) !== null) if (!SAFE_METHODS.test(mm[1])) { reasons.push(`method:${mm[1]}`); break; }
  if (/\$\w+(?:\.\w+)*\s*(?:\+=|-=|\*=|=)\s*(?!\$null)/.test(stripped)) {
    // plain variable assignment is fine; property assignment on an object ($x.Enabled = ...) is not
    if (/\$\w+(?:\.\w+)+\s*(?:\+=|-=|\*=|=)/.test(stripped)) reasons.push("property_assignment");
  }
  // every cmdlet (Verb-Noun) must have a read-only verb
  const cmdletRe = /\b([A-Z][a-zA-Z]{1,15})-([A-Z][A-Za-z0-9]{1,40})\b/g;
  let cm: RegExpExecArray | null;
  while ((cm = cmdletRe.exec(stripped)) !== null) {
    if (!READ_ONLY_VERBS.has(cm[1].toLowerCase())) { reasons.push(`verb:${cm[1]}-${cm[2]}`); break; }
  }
  if (READ_ONLY_EXCEPTIONS.test(stripped)) reasons.push("not_read_only_cmdlet");
  // native executables that mutate (a tiny list; everything else that is not a cmdlet is MODIFY too)
  // only in COMMAND position (line start or after ; | ( &) — a hostname like app.example.com as an argument is not a program
  const nativeRe = /(?:^|[;|(&])[ 	]*([a-z][a-z0-9_.-]*?(?:\.exe|\.cmd|\.bat|\.com))(?=[\s;|)]|$)/gim;
  let nm: RegExpExecArray | null;
  while ((nm = nativeRe.exec(stripped)) !== null) {
    if (!/^(?:ipconfig|hostname|whoami|systeminfo|tasklist|netstat|ping|tracert|nslookup|route|arp|getmac|ver|wmic|where|findstr|tree|dir|type|more|sort|find)\.(?:exe|com)$/i.test(nm[1])) { reasons.push(`native:${nm[1]}`); break; }
  }
  // bare mutating commands (no extension)
  if (/(?:^|[\s;|(])(?:rm|del|erase|rmdir|rd|move|mv|copy|cp|xcopy|robocopy|ren|rename|mkdir|md|md5|attrib|icacls|takeown|cacls|net|sc|reg|schtasks|taskkill|shutdown|bcdedit|wmic\s+\w+\s+(?:call|set|create|delete)|start|sleep|Start-Sleep\s+-s\w*\s+[3-9]\d{2,})\b/i.test(stripped)) reasons.push("mutating_command");
  if (/\|\s*(?:ForEach-Object|%)\s*\{[^}]*(?:Remove|Set|New|Stop|Start|Move|Rename|Copy|Clear|Kill|Delete)\b/i.test(stripped)) reasons.push("mutation_in_loop");
  return reasons.length ? { class: "MODIFY", reasons } : { class: "READ_ONLY", reasons: [] };
}

/** Remove string literals (their contents are data, not commands) and comments before classifying. Keeps paths visible to `scriptPathLiterals` (which runs on the raw text). */
function stripStringsAndComments(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "#") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "<" && s[i + 1] === "#") { const end = s.indexOf("#>", i + 2); i = end < 0 ? s.length : end + 2; continue; }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < s.length) { if (s[i] === "`" && q === '"') { i += 2; continue; } if (s[i] === q) { if (s[i + 1] === q) { i += 2; continue; } break; } i++; }
      i++; out += " __STR__ "; continue;
    }
    out += c; i++;
  }
  return out;
}
