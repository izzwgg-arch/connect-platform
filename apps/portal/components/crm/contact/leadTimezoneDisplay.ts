type LeadTimezoneDisplayInput = {
  timezoneIana?: string | null;
  timezoneLabel?: string | null;
  timezoneResolutionStatus?: "RESOLVED" | "NEEDS_REVIEW" | "MISSING_LOCATION" | null;
};

/** Compact row badge — Phoenix uses AZ (MST, no DST), not generic MT. */
export function leadTimezoneBadgeShort(input: LeadTimezoneDisplayInput): string | null {
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

/** Detail label — Arizona is explicit about MST / no DST. */
export function leadTimezoneDetailLabel(input: LeadTimezoneDisplayInput): string | null {
  const iana = (input.timezoneIana ?? "").trim();
  if (iana === "America/Phoenix") return "Arizona (MST)";
  const label = (input.timezoneLabel ?? "").trim();
  if (label) return label;
  if (input.timezoneResolutionStatus === "NEEDS_REVIEW") return "Needs review";
  if (input.timezoneResolutionStatus === "MISSING_LOCATION") return "No timezone";
  return null;
}

export function leadTimezoneBadgeTitle(input: LeadTimezoneDisplayInput): string | undefined {
  const iana = (input.timezoneIana ?? "").trim();
  if (iana === "America/Phoenix") return "America/Phoenix — Arizona (MST, no DST)";
  if (iana) return iana;
  return input.timezoneResolutionStatus ?? undefined;
}
