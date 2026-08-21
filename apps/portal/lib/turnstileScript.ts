/**
 * The ONE definition of Cloudflare's Turnstile script URL and origin.
 *
 * Two places need it and they MUST agree byte-for-byte:
 *   - app/login/layout.tsx  preloads it (server-rendered, so it lands in the
 *     initial HTML and the browser fetches it in parallel with the page bundle)
 *   - components/TurnstileWidget.tsx  actually appends the <script>
 *
 * ⛔ If the two strings ever differ by so much as the query string, the browser
 * treats them as two different resources: the preload is wasted, the script is
 * downloaded TWICE, and the console logs "preloaded but not used". Hence one
 * constant and a guard test (lib/turnstileWiring.test.ts) that pins both call
 * sites to it.
 */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Base URL, exported so the widget can find an already-injected tag by prefix.
 *
 * ⛔ Spelled out in full rather than built from TURNSTILE_ORIGIN on purpose:
 * this repo verifies deployed bundles and source by GREPPING for strings, and a
 * template-literal URL appears nowhere in a search for the thing you are looking
 * for. turnstileWiring.test.ts asserts the two stay consistent.
 */
export const TURNSTILE_SCRIPT_BASE = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/**
 * `render=explicit` is required: we render into a React-owned node ourselves
 * rather than letting Cloudflare scan the document for `.cf-turnstile`.
 */
export const TURNSTILE_SCRIPT_SRC = `${TURNSTILE_SCRIPT_BASE}?render=explicit`;
