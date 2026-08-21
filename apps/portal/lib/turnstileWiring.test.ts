import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the WIRING of the Cloudflare Turnstile site key into the portal build.
 *
 * The unit under test is not a function — it is four files agreeing with each
 * other. The failure this exists to prevent is silent: if the build arg is
 * dropped from either compose block, or from the Dockerfile, the portal builds
 * and deploys perfectly and simply ships a bundle with no site key, so
 * TurnstileWidget renders nothing and the sign-in page quietly loses its bot
 * check. Nothing errors, no test of any function fails, and the api keeps
 * answering `observed_missing` forever.
 *
 * Same shape as the NEXT_PUBLIC_TELEPHONY_WS_URL and CRM storage-dir traps
 * already recorded in CLAUDE.md: a service defined TWICE in compose (portal +
 * portal_candidate for blue/green) where fixing only one tests perfectly and
 * then loses the value at the next cutover.
 */

// The repo checks compose out CRLF under core.autocrlf=true; a literal newline
// pattern matches nothing there and reads as "the wiring isn't present".
const REPO_ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8").split("\r\n").join("\n");

const COMPOSE = read("docker-compose.app.yml");
const DOCKERFILE = read("apps/portal/Dockerfile");
const LOGIN_PAGE = read("apps/portal/app/login/page.tsx");
const WIDGET = read("apps/portal/components/TurnstileWidget.tsx");

const ARG = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";

function composeBlock(service: string): string {
  const start = COMPOSE.indexOf("\n  " + service + ":\n");
  assert.ok(start > 0, "compose has no " + service + " service");
  const rest = COMPOSE.slice(start + 1);
  const next = rest.search(/\n {2}[a-z_]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

// Reads the ":-default" out of a compose build arg without any escaping games.
function composeArgDefault(service: string): string | undefined {
  const line = composeBlock(service)
    .split("\n")
    .find((l) => l.trim().startsWith(ARG + ":"));
  if (!line) return undefined;
  const marker = ":-";
  const at = line.indexOf(marker);
  if (at === -1) return undefined;
  return line.slice(at + marker.length).replace("}", "").trim();
}

function dockerfileArgDefault(): string | undefined {
  const line = DOCKERFILE.split("\n").find((l) => l.startsWith("ARG " + ARG + "="));
  if (!line) return undefined;
  const parts = line.split('"');
  return parts.length >= 2 ? parts[1] : undefined;
}

test("both portal compose blocks pass the Turnstile site key as a build arg", () => {
  for (const service of ["portal", "portal_candidate"]) {
    const block = composeBlock(service);
    const args = block.slice(block.indexOf("args:"), block.indexOf("environment:"));
    assert.ok(
      args.includes(ARG),
      service + " build args are missing " + ARG + " — that block would ship an unkeyed bundle",
    );
  }
});

test("the portal Dockerfile declares the ARG and passes it into the Next build", () => {
  assert.ok(dockerfileArgDefault() !== undefined, "Dockerfile does not declare the ARG");
  const run = DOCKERFILE.slice(
    DOCKERFILE.indexOf("NEXT_OUTPUT_STANDALONE=1"),
    DOCKERFILE.indexOf("pnpm --filter @connect/portal build"),
  );
  assert.ok(
    run.includes(ARG + '="${' + ARG + '}"'),
    "the ARG is declared but never reaches the build environment, so Next inlines nothing",
  );
});

test("the Dockerfile default and the compose defaults are the same key", () => {
  const inDockerfile = dockerfileArgDefault();
  assert.ok(inDockerfile, "Dockerfile ARG has no default");
  for (const service of ["portal", "portal_candidate"]) {
    assert.equal(
      composeArgDefault(service),
      inDockerfile,
      "the hardcoded site keys have drifted (" + service + ") — a rotation moved one and not the other",
    );
  }
});

test("no default is empty — an empty default is how the check goes missing silently", () => {
  assert.ok(String(dockerfileArgDefault()).startsWith("0x4A"), "the Dockerfile site key must be a real Turnstile key");
  for (const service of ["portal", "portal_candidate"]) {
    assert.ok(
      String(composeArgDefault(service)).startsWith("0x4A"),
      service + " must carry a real Turnstile key, not a blank default",
    );
  }
});

test("the secret key is never wired into any portal build input", () => {
  // The secret belongs to apps/api and .env.platform only. Anything named
  // NEXT_PUBLIC_* is inlined into the JS bundle and served to every visitor.
  assert.ok(!COMPOSE.includes("TURNSTILE_SECRET"), "compose must never hand a Turnstile secret to the portal");
  assert.ok(!DOCKERFILE.includes("TURNSTILE_SECRET"), "the portal Dockerfile must never see a Turnstile secret");
  assert.ok(!WIDGET.includes("TURNSTILE_SECRET"), "the widget must never reference a Turnstile secret");
});

test("the login page renders the widget only when a site key was baked in", () => {
  assert.ok(LOGIN_PAGE.includes("TurnstileWidget"), "login page no longer renders the widget");
  assert.ok(
    LOGIN_PAGE.includes("TURNSTILE_SITE_KEY ? <TurnstileWidget"),
    "the widget must stay gated on the site key — an ungated render would draw an empty box on an unkeyed build",
  );
  assert.ok(LOGIN_PAGE.includes("turnstileToken"), "login page no longer sends the token to /auth/login");
});

test("the widget reads the key from the public build env and nothing else", () => {
  assert.ok(WIDGET.includes("process.env." + ARG), "widget no longer reads the build-time site key");
});
