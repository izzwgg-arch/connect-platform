import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
const MIDDLEWARE = read("apps/portal/middleware.ts");
const SCRIPT_MODULE = read("apps/portal/lib/turnstileScript.ts");

const ARG = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";

/**
 * ⛔ Negative assertions MUST run on executable lines only. Every one of these
 * files carries a doc comment that NAMES the thing being forbidden — the
 * comment explaining "no crossOrigin, because..." contains the word crossOrigin
 * — so a naive `!includes(...)` fails against correct code. This repo has been
 * caught by that three times; strip first, then assert.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

/**
 * The rest of this file guards the LATENCY fix, added after Izzy reported the
 * widget "showed up lazy and then the spinner froze for a while".
 *
 * /login ships no markup, so without these hints the entire chain is serial:
 * bundle -> React boots -> form renders -> effect fires -> only THEN DNS, TLS
 * and the script download start, and only then does the challenge begin. The
 * preload moves the network work in front of React instead of behind it.
 */

test("the sign-in page sends preconnect + preload as a Link HEADER", () => {
  const code = stripComments(MIDDLEWARE);
  assert.ok(code.includes('"Link"'), "the Link header is gone — the hints go back behind the bundle");
  assert.ok(code.includes("rel=preconnect"), "lost the preconnect: DNS+TLS goes back on the critical path");
  assert.ok(code.includes("rel=preload"), "lost the preload: the script download waits for React again");
  assert.ok(code.includes("as=script"), "a preload without as=script is ignored by the browser");
});

test("⛔ the hints are a HEADER, not JSX — JSX does not work on this page", () => {
  // Tried the other way first: a server layout rendering <link rel="preconnect">
  // is serialised into the RSC flight payload rather than emitted as real tags,
  // because /login bails to client-side rendering. The preload scanner never
  // sees it and the links only exist after hydration, which is far too late.
  // Verified by curling /login and finding the hints inside a __next_f.push
  // string instead of among the <link> tags.
  assert.ok(
    !existsSync(join(REPO_ROOT, "apps/portal/app/login/layout.tsx")),
    "a login layout is back — JSX hints there are inert; the Link header in middleware.ts is the mechanism that works",
  );
});

test("the middleware is scoped to /login and does nothing else", () => {
  const code = stripComments(MIDDLEWARE);
  assert.match(code, /matcher:\s*\["\/login"\]/, "the matcher must stay pinned to /login — a hint on every page is waste");
  assert.ok(code.includes("NextResponse.next()"), "middleware must pass the request straight through");
  // It runs in front of the sign-in page: a fault here means nobody can log in.
  assert.ok(
    !/redirect|rewrite|cookies|fetch\(/.test(code),
    "this middleware must stay trivial — no redirects, rewrites, cookies or fetches in front of sign-in",
  );
});

test("the preload and the widget resolve to the SAME url", () => {
  // Byte-identical or the browser fetches twice and logs "preloaded but not used".
  assert.ok(SCRIPT_MODULE.includes("TURNSTILE_SCRIPT_SRC"), "the shared script module lost its URL export");
  assert.ok(MIDDLEWARE.includes("TURNSTILE_SCRIPT_SRC"), "the layout hardcodes a URL instead of using the shared constant");
  assert.ok(WIDGET.includes("TURNSTILE_SCRIPT_SRC"), "the widget hardcodes a URL instead of using the shared constant");
  for (const [name, src] of [["layout", MIDDLEWARE], ["widget", WIDGET]] as const) {
    assert.ok(
      !stripComments(src).includes("challenges.cloudflare.com/turnstile"),
      name + " hardcodes the script URL again — the two can now drift apart",
    );
  }
});

test("the shared script URL is spelled out in full and matches its origin", () => {
  // Full literal so a grep for the URL finds it; consistency asserted here
  // because the two are now written out separately.
  assert.ok(
    SCRIPT_MODULE.includes('"https://challenges.cloudflare.com/turnstile/v0/api.js"'),
    "the script URL must stay a full literal — this repo greps bundles and source by string",
  );
  const origin = SCRIPT_MODULE.match(/TURNSTILE_ORIGIN = "([^"]+)"/)?.[1];
  const base = SCRIPT_MODULE.match(/TURNSTILE_SCRIPT_BASE = "([^"]+)"/)?.[1];
  assert.ok(origin && base, "origin or base is no longer a plain literal");
  assert.ok(String(base).startsWith(String(origin)), "the preconnect origin and the script URL have drifted apart");
});

test("the hints carry no crossOrigin", () => {
  // The widget appends a plain <script src> with no crossorigin attribute. A
  // CORS-mode hint does not match that request, so it opens a SECOND connection
  // and warms nothing.
  assert.ok(
    !stripComments(MIDDLEWARE).includes("crossOrigin"),
    "a crossOrigin hint does not match the widget's plain script fetch",
  );
});
