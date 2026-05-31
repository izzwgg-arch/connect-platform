import cityTimezones from "city-timezones";

export type CrmLeadTimezoneResolutionStatus = "RESOLVED" | "NEEDS_REVIEW" | "MISSING_LOCATION";

export type LeadTimezoneResolution = {
  timezoneIana: string | null;
  timezoneLabel: string | null;
  timezoneOffsetMinutes: number | null;
  timezoneResolutionStatus: CrmLeadTimezoneResolutionStatus;
};

export const STANDARD_TIMEZONE_LABELS = [
  "Eastern",
  "Central",
  "Mountain",
  "Pacific",
  "Alaska",
  "Hawaii",
] as const;

export type StandardTimezoneLabel = (typeof STANDARD_TIMEZONE_LABELS)[number];

export type TimezoneZoneFilter =
  | "eastern"
  | "central"
  | "mountain"
  | "pacific"
  | "alaska"
  | "hawaii"
  | "other";

export type LeadTimezoneDisplayLabel = StandardTimezoneLabel | "Arizona" | "Other";

const US_STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const IANA_TO_LABEL: Record<string, LeadTimezoneDisplayLabel> = {
  "America/New_York": "Eastern",
  "America/Detroit": "Eastern",
  "America/Indiana/Indianapolis": "Eastern",
  "America/Indiana/Knox": "Central",
  "America/Indiana/Marengo": "Eastern",
  "America/Indiana/Petersburg": "Eastern",
  "America/Indiana/Tell_City": "Central",
  "America/Indiana/Vevay": "Eastern",
  "America/Indiana/Vincennes": "Eastern",
  "America/Indiana/Winamac": "Eastern",
  "America/Kentucky/Louisville": "Eastern",
  "America/Kentucky/Monticello": "Eastern",
  "America/Chicago": "Central",
  "America/Menominee": "Central",
  "America/North_Dakota/Beulah": "Central",
  "America/North_Dakota/Center": "Central",
  "America/North_Dakota/New_Salem": "Central",
  "America/Denver": "Mountain",
  "America/Boise": "Mountain",
  "America/Phoenix": "Arizona",
  "America/Los_Angeles": "Pacific",
  "America/Anchorage": "Alaska",
  "America/Juneau": "Alaska",
  "America/Metlakatla": "Alaska",
  "America/Nome": "Alaska",
  "America/Sitka": "Alaska",
  "America/Yakutat": "Alaska",
  "Pacific/Honolulu": "Hawaii",
};

/** IANA zones included in the Mountain filter bucket (DST + non-DST). */
export const MOUNTAIN_FILTER_IANAS = ["America/Denver", "America/Boise", "America/Phoenix"] as const;

/** Stored labels included in the Mountain filter bucket. */
export const MOUNTAIN_FILTER_LABELS = ["Mountain", "Arizona"] as const;

/** Default IANA when only a US state is known (population-weighted primary zone). */
const US_STATE_DEFAULT_IANA: Record<string, string> = {
  AL: "America/Chicago",
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  AR: "America/Chicago",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  CT: "America/New_York",
  DC: "America/New_York",
  DE: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  ID: "America/Boise",
  IL: "America/Chicago",
  IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago",
  KS: "America/Chicago",
  KY: "America/New_York",
  LA: "America/Chicago",
  ME: "America/New_York",
  MD: "America/New_York",
  MA: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  MS: "America/Chicago",
  MO: "America/Chicago",
  MT: "America/Denver",
  NE: "America/Chicago",
  NV: "America/Los_Angeles",
  NH: "America/New_York",
  NJ: "America/New_York",
  NM: "America/Denver",
  NY: "America/New_York",
  NC: "America/New_York",
  ND: "America/Chicago",
  OH: "America/New_York",
  OK: "America/Chicago",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  RI: "America/New_York",
  SC: "America/New_York",
  SD: "America/Chicago",
  TN: "America/Chicago",
  TX: "America/Chicago",
  UT: "America/Denver",
  VT: "America/New_York",
  VA: "America/New_York",
  WA: "America/Los_Angeles",
  WV: "America/New_York",
  WI: "America/Chicago",
  WY: "America/Denver",
};

type CityTimezoneHit = {
  city?: string;
  state_ansi?: string;
  iso2?: string;
  timezone?: string;
};

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

export function normalizeUsStateAbbrev(state: string | null | undefined): string | null {
  const raw = trimOrNull(state);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  const mapped = US_STATE_NAME_TO_ABBR[raw.toLowerCase()];
  return mapped ?? null;
}

export function normalizeCityName(city: string | null | undefined): string | null {
  return trimOrNull(city);
}

export function locationKey(city: string | null | undefined, state: string | null | undefined): string {
  return `${normalizeCityName(city) ?? ""}|${normalizeUsStateAbbrev(state) ?? ""}`;
}

export function shouldRecomputeLeadTimezone(
  prevCity: string | null | undefined,
  prevState: string | null | undefined,
  nextCity: string | null | undefined,
  nextState: string | null | undefined,
): boolean {
  return locationKey(prevCity, prevState) !== locationKey(nextCity, nextState);
}

export function ianaToTimezoneLabel(iana: string): LeadTimezoneDisplayLabel {
  return IANA_TO_LABEL[iana] ?? "Other";
}

/** Compact badge text for list rows — Phoenix is AZ/MST, not generic MT. */
export function leadTimezoneBadgeShort(input: {
  timezoneIana?: string | null;
  timezoneLabel?: string | null;
}): string | null {
  const iana = (input.timezoneIana ?? "").trim();
  if (iana === "America/Phoenix") return "AZ";
  const label = (input.timezoneLabel ?? "").trim();
  if (!label) return null;
  switch (label) {
    case "Eastern":
      return "ET";
    case "Central":
      return "CT";
    case "Mountain":
      return "MT";
    case "Arizona":
      return "AZ";
    case "Pacific":
      return "PT";
    case "Alaska":
      return "AK";
    case "Hawaii":
      return "HI";
    default:
      return label.slice(0, 6);
  }
}

/** Detail panel label — clarifies Arizona does not observe DST. */
export function leadTimezoneDetailLabel(input: {
  timezoneIana?: string | null;
  timezoneLabel?: string | null;
  timezoneResolutionStatus?: CrmLeadTimezoneResolutionStatus | null;
}): string | null {
  const iana = (input.timezoneIana ?? "").trim();
  if (iana === "America/Phoenix") return "Arizona (MST)";
  const label = (input.timezoneLabel ?? "").trim();
  if (label) return label;
  if (input.timezoneResolutionStatus === "NEEDS_REVIEW") return "Needs review";
  if (input.timezoneResolutionStatus === "MISSING_LOCATION") return "No timezone";
  return null;
}

export function timezoneZoneToLabel(zone: TimezoneZoneFilter): StandardTimezoneLabel | null {
  switch (zone) {
    case "eastern":
      return "Eastern";
    case "central":
      return "Central";
    case "mountain":
      return "Mountain";
    case "pacific":
      return "Pacific";
    case "alaska":
      return "Alaska";
    case "hawaii":
      return "Hawaii";
    default:
      return null;
  }
}

export function computeTimezoneOffsetMinutes(iana: string, at: Date = new Date()): number {
  try {
    const utcMs = at.getTime() + at.getTimezoneOffset() * 60_000;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(utcMs));
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const second = Number(parts.find((p) => p.type === "second")?.value ?? "0");
    const tzAsUtcMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hour, minute, second);
    return Math.round((tzAsUtcMs - utcMs) / 60_000);
  } catch {
    return 0;
  }
}

function uniqueTimezones(hits: CityTimezoneHit[]): string[] {
  return [...new Set(hits.map((h) => h.timezone).filter((tz): tz is string => !!tz))];
}

function filterUsHits(hits: CityTimezoneHit[], stateAbbr: string | null): CityTimezoneHit[] {
  const usHits = hits.filter((h) => h.iso2 === "US" && h.timezone);
  if (!stateAbbr) return usHits;
  const stateHits = usHits.filter((h) => h.state_ansi === stateAbbr);
  return stateHits.length > 0 ? stateHits : usHits;
}

function lookupCityState(city: string, stateAbbr: string | null): CityTimezoneHit[] {
  const byCity = filterUsHits(cityTimezones.lookupViaCity(city) as CityTimezoneHit[], stateAbbr);
  if (byCity.length > 0) return byCity;

  const search = stateAbbr ? `${city} ${stateAbbr}` : city;
  return filterUsHits(cityTimezones.findFromCityStateProvince(search) as CityTimezoneHit[], stateAbbr);
}

function resolvedFromIana(iana: string, status: CrmLeadTimezoneResolutionStatus): LeadTimezoneResolution {
  const label = ianaToTimezoneLabel(iana);
  return {
    timezoneIana: iana,
    timezoneLabel: label,
    timezoneOffsetMinutes: computeTimezoneOffsetMinutes(iana),
    timezoneResolutionStatus: status,
  };
}

function missingLocation(): LeadTimezoneResolution {
  return {
    timezoneIana: null,
    timezoneLabel: null,
    timezoneOffsetMinutes: null,
    timezoneResolutionStatus: "MISSING_LOCATION",
  };
}

function needsReview(): LeadTimezoneResolution {
  return {
    timezoneIana: null,
    timezoneLabel: null,
    timezoneOffsetMinutes: null,
    timezoneResolutionStatus: "NEEDS_REVIEW",
  };
}

/**
 * Resolve a US lead timezone from city + state using the city-timezones dataset.
 * Never throws — returns NEEDS_REVIEW or MISSING_LOCATION on failure.
 */
export function resolveLeadTimezoneFromLocation(
  cityInput: string | null | undefined,
  stateInput: string | null | undefined,
): LeadTimezoneResolution {
  try {
    const city = normalizeCityName(cityInput);
    const stateAbbr = normalizeUsStateAbbrev(stateInput);

    if (!city && !stateAbbr) return missingLocation();

    if (city) {
      const hits = lookupCityState(city, stateAbbr);
      const zones = uniqueTimezones(hits);

      if (zones.length === 1) {
        return resolvedFromIana(zones[0], "RESOLVED");
      }

      if (zones.length > 1) {
        return needsReview();
      }

      if (stateAbbr) {
        const fallback = US_STATE_DEFAULT_IANA[stateAbbr];
        if (fallback) {
          return resolvedFromIana(fallback, "NEEDS_REVIEW");
        }
      }

      return needsReview();
    }

    if (stateAbbr) {
      const fallback = US_STATE_DEFAULT_IANA[stateAbbr];
      if (fallback) {
        return resolvedFromIana(fallback, "NEEDS_REVIEW");
      }
    }

    return needsReview();
  } catch {
    return needsReview();
  }
}

export type LeadTimezoneMetaFilterInput = {
  timezoneIana?: string;
  timezoneLabel?: string;
  timezoneZone?: string;
};

/** Build a Prisma `crmMeta.is` fragment for timezone filters. Always tenant-scoped by caller. */
export function buildLeadTimezoneMetaFilter(
  input: LeadTimezoneMetaFilterInput,
): Record<string, unknown> | undefined {
  const zoneRaw = (input.timezoneZone ?? "").trim().toLowerCase();
  if (zoneRaw === "other") {
    return {
      OR: [
        { timezoneResolutionStatus: "NEEDS_REVIEW" },
        { timezoneResolutionStatus: "MISSING_LOCATION" },
        { timezoneLabel: "Other" },
        { timezoneLabel: null },
      ],
    };
  }

  const zoneLabel = timezoneZoneToLabel(zoneRaw as TimezoneZoneFilter);
  if (zoneLabel === "Mountain") {
    return {
      OR: [
        { timezoneLabel: { in: [...MOUNTAIN_FILTER_LABELS] } },
        { timezoneIana: { in: [...MOUNTAIN_FILTER_IANAS] } },
      ],
    };
  }
  if (zoneLabel) {
    return { timezoneLabel: zoneLabel };
  }

  const iana = (input.timezoneIana ?? "").trim();
  if (iana) {
    return { timezoneIana: iana };
  }

  const label = (input.timezoneLabel ?? "").trim();
  if (label) {
    return { timezoneLabel: label };
  }

  return undefined;
}
