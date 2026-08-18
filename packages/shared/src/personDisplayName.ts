/**
 * The ONE place Connect decides what to call a person.
 *
 * ⛔⛔ THE RULE (Izzy, 2026-08-17): **the PBX extension name is ALWAYS the source
 * of truth.** Not the login email, not whatever got typed into the User name
 * columns. It applies to existing customers AND to brand-new sign-ups, because
 * at onboarding the name the customer types for each person becomes that
 * person's extension name (`ext_name: person.name`,
 * `apps/api/src/onboarding/pbxTenantBuild.ts`). So there is exactly ONE rule
 * here, never a "new tenants behave differently" branch.
 *
 * ⛔ And if the PBX calls an extension "Front Desk", then the person is called
 * Front Desk — that was asked and answered explicitly. Do not add cleverness
 * that tries to detect "that isn't a real person's name" and fall back to the
 * email; the email address is the thing we are getting away from.
 *
 * Why this file exists at all: before 2026-08-17 the name was resolved
 * independently in the portal and in apps/api, and the api copy never looked at
 * the extension — so 55 of 65 live customers were greeted by the front half of
 * their email address ("Welcome, 845luzerj") and real invitations went out
 * saying "Hi s,". Audit:
 * `docs/ai-context/AGENT_HANDOFF_USER_NAMES_EMAIL_VS_PBX_2026-08-17.md`.
 */

export type PersonNameInput = {
  /** The PBX name, off `Extension.displayName`. Wins over everything else. */
  extensionDisplayName?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Some tenants prefix the extension name with its own number — Trust
 * Bookkeepings has `"105 - Mrs. Halpert"` and `"101- Mr. Sofer"` (note: no
 * space before the dash on 101, so anything stricter than this misses it).
 *
 * ⛔ This strip is NOT cosmetic. Screens that showed the first word of the name
 * would otherwise greet her "Welcome, 105" — worse than the email address we
 * are replacing.
 *
 * Deliberately conservative: it only strips when a letter actually follows, so
 * an extension genuinely named "110" or "24-7" keeps its name instead of being
 * blanked.
 */
export function stripExtensionNumberPrefix(rawName?: string | null): string {
  const name = clean(rawName);
  if (!name) return "";
  const stripped = name.replace(/^\s*\d{2,5}\s*[-–—:]\s*(?=[^\s\d])/, "");
  return stripped.trim() || name;
}

/**
 * Capitalise the first letter of each word, however the name was typed
 * (Izzy, 2026-08-17: *"even if the customer enters it in lower case, you should
 * always use uppercase on the first"*). So `baila` reads **Baila** and
 * `home 2` reads **Home 2**.
 *
 * ⛔ It only ever RAISES a lowercase first letter — it never lowercases
 * anything. That is what protects the names people deliberately typed that way:
 * `TEMP` stays TEMP, `S M Weiss` stays, `McNamara` keeps its inner capital, and
 * `Mrs. Halpert` is untouched. A naive `toLowerCase()` first would wreck all
 * four.
 *
 * ⛔ Words split on whitespace and hyphens, NOT apostrophes — `mary-jane`
 * becomes Mary-Jane, but treating `'` as a separator would turn
 * `shloime's phone` into "Shloime'S Phone".
 */
export function capitalizeNameWords(rawName?: string | null): string {
  const name = clean(rawName);
  if (!name) return "";
  return name.replace(/(^|[\s\-–—])(\p{Ll})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * True when the stored name is nothing but initials — `firstName:"e"`,
 * `lastName:"l"` for Eli Lovi. Thirteen live users carry these (seeded
 * 2026-04-06) and they are what produced real emails reading "Hi e,".
 *
 * ⛔ Only ever used to SKIP a stored name, never to reject a PBX name.
 */
function isInitialsOnly(parts: string[]): boolean {
  return parts.length > 0 && parts.every((p) => p.replace(/\./g, "").length <= 1);
}

/**
 * What to call this person, in one string.
 *
 * Order: the PBX extension name → a real stored name → the email local part.
 * `fallback` is only reached by a record with no extension, no name and no
 * email, which should not exist.
 *
 * ⛔ Returns the WHOLE name and never splits it into a first name. Splitting is
 * what makes this go wrong: "Front Desk" becomes "Hi Front," and
 * "Mrs. Halpert" becomes "Hi Mrs.," — both worse than saying the full name.
 */
export function resolvePersonDisplayName(input: PersonNameInput, fallback = "there"): string {
  // Every branch below returns through capitalizeNameWords() — a name typed in
  // lower case still reads as a name on screen and in an email.
  const fromPbx = stripExtensionNumberPrefix(input.extensionDisplayName);
  if (fromPbx) return capitalizeNameWords(fromPbx);

  const stored = clean(input.displayName);
  const email = clean(input.email);
  const emailLocal = email.includes("@") ? email.split("@")[0] : email;

  // An "@" in the stored name means somebody pasted an address into the name
  // box; that is the email address wearing a hat, so treat it as absent.
  if (stored && !stored.includes("@")) return capitalizeNameWords(stored);

  const parts = [input.firstName, input.lastName].map(clean).filter(Boolean);
  if (parts.length && !isInitialsOnly(parts)) return capitalizeNameWords(parts.join(" "));

  return capitalizeNameWords(emailLocal) || fallback;
}

/**
 * The same answer, for places that greet somebody ("Hi ___,"). It is
 * deliberately identical to {@link resolvePersonDisplayName} — see the note
 * there about why the name is never cut down to a first name.
 */
export function resolvePersonGreetingName(input: PersonNameInput, fallback = "there"): string {
  return resolvePersonDisplayName(input, fallback);
}
