export type TimezoneZoneFilter =
  | "all"
  | "eastern"
  | "central"
  | "mountain"
  | "pacific"
  | "alaska"
  | "hawaii"
  | "other";

export const QUEUE_TIMEZONE_ZONE_OPTIONS: Array<{ value: TimezoneZoneFilter; label: string }> = [
  { value: "all", label: "All timezones" },
  { value: "eastern", label: "Eastern" },
  { value: "central", label: "Central" },
  { value: "mountain", label: "Mountain" },
  { value: "pacific", label: "Pacific" },
  { value: "alaska", label: "Alaska" },
  { value: "hawaii", label: "Hawaii" },
  { value: "other", label: "Other / Needs review" },
];

export const QUEUE_TIMEZONE_FILTER_KEY = "crm_queue_timezone_zone";
