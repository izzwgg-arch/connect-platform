/**
 * The settings every Loopcom desk phone gets, whether anyone asks for them or not.
 *
 * Izzy, 2026-08-21: "time zone should always be set to New York and 12 hours",
 * "each phone should be set to automatically change between daylight savings",
 * "each phone should have backlight always on and voicemail set to *97."
 *
 * ⛔⛔ THESE ARE APPLIED, NOT OFFERED. They are not a form the customer fills in.
 * The reason is sitting in production right now: `provisioning.templates` holds
 * FIVE different timezone values across the fleet, including id 21 "BV 106" at
 * `-12|Eniwetok,Kwajalein` — the Marshall Islands — so that customer's handset has
 * been showing a time seventeen hours out and nobody reported it. Another template
 * has `summer_time = 1` (manual) rather than 2 (automatic), so its clock will be an
 * hour wrong twice a year until somebody notices. A per-phone choice is how that
 * happened; a house standard is how it stops.
 *
 * ⛔ Every value below was READ OFF OUR OWN WORKING PHONES, not taken from a vendor
 * doc. `-5|United States-Eastern Time`, `time_format = 0`, `summer_time = 2` are
 * exactly what the healthy Yealink templates on the production PBX carry today.
 */

/** What we want to be true of a phone, said in vendor-neutral terms. */
export type PhoneStandards = {
  /** IANA-style label, for humans and for anything that is not Yealink. */
  timeZoneLabel: string;
  /** Yealink stores the offset and the name in one string, pipe separated. */
  timeZoneRaw: string;
  clock: "12h" | "24h";
  /** Let the phone move its own clock in spring and autumn. */
  daylightSaving: "automatic" | "manual" | "off";
  /** The screen never sleeps: a dark phone reads as a dead phone. */
  backlight: "always-on" | "timed";
  /** What the voicemail button dials. */
  voicemailNumber: string;
};

export const LOOPCOM_PHONE_STANDARDS: PhoneStandards = {
  timeZoneLabel: "America/New_York",
  timeZoneRaw: "-5|United States-Eastern Time",
  clock: "12h",
  daylightSaving: "automatic",
  backlight: "always-on",
  voicemailNumber: "*97",
};

/**
 * The four columns VitalPBX already understands on a `provisioning.templates` row.
 *
 * ⛔ These are strings on purpose — the column type is varchar/longtext and MySQL
 * will happily coerce a number into something that reads back differently. The
 * existing healthy rows are strings; match them exactly.
 */
export type TemplateColumnStandards = {
  timezone: string;
  time_format: string;
  date_format: string;
  summer_time: string;
};

export function templateColumnStandards(
  s: PhoneStandards = LOOPCOM_PHONE_STANDARDS,
): TemplateColumnStandards {
  return {
    timezone: s.timeZoneRaw,
    // Yealink local_time.time_format: 0 = 12 hour, 1 = 24 hour.
    time_format: s.clock === "12h" ? "0" : "1",
    // 0 = WWW MMM DD. Left at the fleet's existing value rather than invented.
    date_format: "0",
    // Yealink local_time.summer_time: 0 = off, 1 = on (manual), 2 = automatic.
    summer_time: s.daylightSaving === "automatic" ? "2" : s.daylightSaving === "manual" ? "1" : "0",
  };
}

/**
 * The config keys VitalPBX does NOT manage, which we therefore have to write into
 * the template body ourselves.
 *
 * ⛔ `voice_mail.number.N` is per line and the base template leaves it blank, so a
 * Loopcom phone's voicemail button does nothing at all until this is set. That is
 * not a nicety — it is a button on the handset that silently fails.
 *
 * ⛔⛔ `sip.notify_reset.enable` is the load-bearing one. With it set, a phone that
 * is registered to us can be factory reset over SIP FROM THE PBX — no office
 * network access, no administrator password, nothing installed on the customer's
 * machine. Without it, every reset needs the local path and a credential. It costs
 * one line and it is the difference between the easy case and the hard one.
 *
 * ⛔ `account.N.sip_trust_ctrl` is what stops that same door being open to anyone
 * else: the phone will only act on SIP control from the server it is registered to.
 * Never ship notify_reset without it.
 */
export type ExtraConfigKey = { key: string; value: string; why: string };

/** How many line keys to write the per-account values for. Yealink phones cap well below this. */
const MAX_ACCOUNTS = 16;

export function yealinkStandardConfigKeys(
  s: PhoneStandards = LOOPCOM_PHONE_STANDARDS,
  opts: { accounts?: number } = {},
): ExtraConfigKey[] {
  const accounts = Math.max(1, Math.min(MAX_ACCOUNTS, opts.accounts ?? 1));
  const out: ExtraConfigKey[] = [
    {
      key: "phone_setting.backlight_time",
      // 0 is "always on"; 1..3600 is a timeout in seconds.
      value: s.backlight === "always-on" ? "0" : "30",
      why: "the screen never sleeps, so a working phone never looks dead",
    },
    {
      key: "sip.notify_reset.enable",
      value: "1",
      why: "lets the PBX factory reset this phone over SIP, with no password and no office access",
    },
  ];
  for (let i = 1; i <= accounts; i += 1) {
    out.push({
      key: `voice_mail.number.${i}`,
      value: s.voicemailNumber,
      why: "the voicemail button on the handset dials this",
    });
    out.push({
      key: `account.${i}.sip_trust_ctrl`,
      value: "1",
      why: "only the PBX this line is registered to may send it control messages",
    });
  }
  return out;
}

/**
 * Rewrite a Yealink template body so it carries our standards.
 *
 * ⛔⛔ IT EDITS IN PLACE AND NEVER APPENDS BLINDLY. A Yealink config is last-value-
 * wins, so appending would work — right up until somebody reads the file to check a
 * setting, finds the vendor's blank line first, and concludes the setting is not
 * applied. Worse, VitalPBX's own generator re-emits some keys, and two copies of a
 * key in a file nobody can diff is how a fleet drifts. Replace the line that is
 * already there; only append a key the template genuinely does not mention.
 *
 * ⛔ Blade placeholders (`{{ $timeFormat ?? 0 }}`) are LEFT ALONE. Those are fed by
 * the template's own columns, which `templateColumnStandards` sets — overwriting the
 * placeholder with a literal would take the setting out of VitalPBX's hands and make
 * the columns lie about what the phone has.
 */
export function applyYealinkStandards(
  templateBody: string,
  s: PhoneStandards = LOOPCOM_PHONE_STANDARDS,
  opts: { accounts?: number } = {},
): { body: string; replaced: string[]; appended: string[] } {
  const replaced: string[] = [];
  const appended: string[] = [];
  let body = templateBody;

  for (const { key, value } of yealinkStandardConfigKeys(s, opts)) {
    // Match "key =", "key=", leading whitespace, any existing value, to end of line.
    const re = new RegExp(`^([ \\t]*)${escapeForRegex(key)}[ \\t]*=.*$`, "m");
    const hit = re.exec(body);
    if (hit) {
      // ⛔ A line whose value is a Blade placeholder is VitalPBX's to fill. Leave it.
      if (/\{\{/.test(hit[0])) continue;
      body = body.replace(re, `${hit[1]}${key} = ${value}`);
      replaced.push(key);
    } else {
      appended.push(key);
    }
  }

  if (appended.length) {
    const block = appended
      .map((k) => {
        const found = yealinkStandardConfigKeys(s, opts).find((e) => e.key === k)!;
        return `${found.key} = ${found.value}`;
      })
      .join("\n");
    body = `${body.replace(/\s*$/, "")}\n\n${STANDARDS_BANNER}\n${block}\n`;
  }

  return { body, replaced, appended };
}

export const STANDARDS_BANNER =
  "#### Loopcom standard settings - applied to every phone, do not edit by hand ####";

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does a template row already meet the house standard?
 *
 * Used to find the phones that are wrong today — which is how the Marshall Islands
 * one surfaces — and to decide whether a template needs rewriting at all.
 */
export type StandardsDrift = { column: keyof TemplateColumnStandards; found: string; expected: string };

export function templateStandardsDrift(
  row: Partial<Record<keyof TemplateColumnStandards, unknown>>,
  s: PhoneStandards = LOOPCOM_PHONE_STANDARDS,
): StandardsDrift[] {
  const want = templateColumnStandards(s);
  const out: StandardsDrift[] = [];
  for (const column of Object.keys(want) as (keyof TemplateColumnStandards)[]) {
    const raw = row[column];
    // ⛔ null and "" are drift, not "unset". A blank timezone means the handset
    // falls back to the vendor default, which is China.
    const found = raw === null || raw === undefined ? "" : String(raw);
    if (found !== want[column]) out.push({ column, found, expected: want[column] });
  }
  return out;
}
