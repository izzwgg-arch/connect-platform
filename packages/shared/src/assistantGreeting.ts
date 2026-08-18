/**
 * How the assistant panel greets someone when it opens.
 *
 * Small, but it is the first line every customer reads on every page, and both
 * halves have a way of going wrong that is only obvious once it is in front of
 * a real account.
 */

/**
 * The name to greet someone by, or nothing at all.
 *
 * ⛔ The portal's `user.name` FALLS BACK TO THE EMAIL ADDRESS when no display
 * name is set (`useAppContext`), so greeting blindly produces "Good afternoon,
 * izzy@gmail.com." — which is worse than not greeting at all. Anything
 * email-shaped is refused, as is the literal placeholder "User".
 *
 * Only the first word is used: "Good afternoon, Joel." — never the full name,
 * which reads like a form letter.
 */
export function greetingName(raw: string | null | undefined): string | null {
  const name = String(raw || "").trim();
  if (!name || name.includes("@") || name.toLowerCase() === "user") return null;
  const first = name.split(/\s+/)[0].replace(/[^\p{L}\p{N}'’-]/gu, "");
  return first.length >= 2 && first.length <= 20 ? first : null;
}

/**
 * Morning / afternoon / evening, from the BROWSER's clock — deliberately not
 * the server's. Connect's server sits in France; a customer in New York opening
 * the panel at 4pm would otherwise be told "Good evening".
 */
export function timeGreeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** The whole line, so the panel never has to assemble it two different ways. */
export function assistantGreetingLine(rawName: string | null | undefined, now: Date = new Date()): string {
  const first = greetingName(rawName);
  return first ? `${timeGreeting(now)}, ${first}.` : `${timeGreeting(now)}.`;
}
