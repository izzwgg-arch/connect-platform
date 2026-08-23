/**
 * Rotate the robot panel user's password THROUGH THE PANEL (2026-08-23).
 *
 * PROVEN LIVE 2026-08-23 (clone rehearsal first, then production): the panel's
 * users edit form takes a plain `password` field and computes its own salted
 * hash (ombu_users.password is binary(64), NOT bcrypt and NOT plain sha512 —
 * never write the hash directly). Run from /root/console-proof on loopcom via
 * the run-wrapper pattern; the password value only ever lives in root-only
 * files, never in a transcript. After rotating: update
 * /etc/connect-robot/credentials.env AND recreate the api (env_file is read at
 * container create), and rotate the CLONE's copy too or its harnesses break.
 *
 * "Replay the panel" — the same principle the whole console rests on: load the
 * user's own edit form, set the password field, re-post the whole form so
 * VitalPBX computes whatever salted hash it uses. Never touch the hash directly.
 *
 * MODES (env PROOF_MODE):
 *   set   — post the users edit form with PROOF_NEW_PASS; print the save result
 *   login — open a FRESH session with PROOF_TRY_USER/PROOF_TRY_PASS; print ok/fail
 *
 * Requires: PANEL_BASE, ROBOT_USER, ROBOT_PASS (current, for the editing session),
 *           PROOF_USER_ID (the ombu_users id to edit).
 */
import { PanelSession } from "../../apps/api/src/onboarding/panelClient";
import { parseForm, applyOverrides, DEVICE_FIELDS } from "../../apps/api/src/pbxConsole/panelForm";

const BASE = process.env.PANEL_BASE || "";
if (!/^https:\/\/(127\.0\.0\.1:8443|[a-z0-9.]+)$/.test(BASE)) throw new Error("bad base");

async function setPassword() {
  const s = new PanelSession(BASE, { id: "robot", user: process.env.ROBOT_USER!, pass: process.env.ROBOT_PASS! } as any);
  await s.login();
  const html = await s.loadForm("users", "edit", process.env.PROOF_USER_ID!);
  const form = parseForm(html);
  // re-post the whole edit form with ONLY the password changed. Everything else
  // — username, role, tenants, displayname, flags — is carried verbatim so the
  // account is otherwise byte-unchanged.
  const pairs = applyOverrides(form, { set: { password: process.env.PROOF_NEW_PASS! } });
  // ensure the routing trio is the form's own (never the request's)
  for (const [k, v] of [["class", "users"], ["method", "put"], ["mode", "edit"]] as Array<[string, string]>) {
    const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
  }
  const r = await s.post(pairs);
  const j: any = r.json || {};
  const errs = ((String(j?.html || "").match(/<li[^>]*>([\s\S]*?)<\/li>/gi)) || []).map((x) => x.replace(/<[^>]+>/g, " ").trim());
  const ok = j?.notification?.type === "success" || j?.state === "success";
  console.log("SET:", ok ? "OK" : "REFUSED", "|", String(j?.notification?.text || errs.join(" | ") || r.text.slice(0, 160)).replace(/<[^>]+>/g, " ").trim().slice(0, 200));
  process.exit(ok ? 0 : 3);
}

async function tryLogin() {
  const s = new PanelSession(BASE, { id: "try", user: process.env.PROOF_TRY_USER!, pass: process.env.PROOF_TRY_PASS! } as any);
  try {
    await s.login();
    // prove the session is real by loading a form
    const html = await s.loadForm("tenants", "edit", "2").catch(() => "");
    console.log("LOGIN: OK" + (html && html.length > 100 ? " (session usable)" : " (login accepted, form empty)"));
    process.exit(0);
  } catch (e: any) {
    console.log("LOGIN: FAIL |", (e?.message || e).toString().slice(0, 120));
    process.exit(4);
  }
}

(process.env.PROOF_MODE === "set" ? setPassword() : tryLogin())
  .catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
