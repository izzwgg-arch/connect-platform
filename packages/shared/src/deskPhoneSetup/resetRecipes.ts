/**
 * How a PERSON factory-resets each family of phone — the one thing the customer does
 * in the guided setup (Izzy, 2026-09-18: "All we have to do is get the customer to
 * factory reset the phones, and that's it. The system takes it from there… an
 * illustration for each phone, for each brand, on how to factory reset").
 *
 * ⛔ One recipe per MODEL FAMILY, never per model: 427 catalogue models collapse to a
 * dozen reset procedures, and a per-model table is a per-model maintenance debt.
 *
 * ⛔⛔ HONESTY IS THE RULE OF THIS FILE. `confidence` says how each recipe is known:
 *   • "proven"     — a human did it on a real handset in front of us and it worked.
 *   • "documented" — the maker's own guide says so; nobody here has pressed the keys.
 *   • "inferred"   — the usual shape for that maker, not checked against a manual.
 *   • "generic"    — no family-specific recipe; the screen shows the generic card and
 *                    Laybel guides key by key from what the person sees.
 * The screen NEVER dresses an inferred recipe up as certain: below "documented" the
 * steps carry the maker's default password caveat and Laybel is told to expect drift.
 *
 * ⛔ Every step is written for a person holding the phone, not for a technician: no
 * "P-values", no "LCD", no "provisioning". Words the phone's own screen shows are
 * quoted so the person can match them.
 */

import { vendorSlugFor } from "./vendorAdapters";
import type { VendorSlug } from "./vendorCatalog.generated";

export type ResetIllustration =
  /** A desk phone with the round OK key held down (Yealink T-series). */
  | "hold_ok"
  /** A desk phone with the Menu soft key / button highlighted (menu-path resets). */
  | "menu_path"
  /** A phone whose reset lives behind a settings menu that asks for a password. */
  | "menu_password"
  /** A screenless box (ATA, DECT base) with a pinhole reset button. */
  | "pinhole"
  /** Nothing family-specific: a plain phone outline. */
  | "generic";

export type ResetConfidence = "proven" | "documented" | "inferred" | "generic";

export type ResetRecipe = {
  /** Stable id for telemetry and for the illustration library. */
  family: string;
  /** The maker slug this recipe belongs to (null for the generic card). */
  vendor: VendorSlug | null;
  /** One line the screen shows above the steps ("Hold OK for 10 seconds"). */
  headline: string;
  /** Numbered, in the person's words. The last step always says the phone restarts by itself. */
  steps: string[];
  /** For hold-style resets: how long the key is held, so the screen can show a countdown. */
  holdSeconds: number | null;
  illustration: ResetIllustration;
  confidence: ResetConfidence;
  /**
   * The maker's factory password when the recipe needs one. ⛔ NEVER a customer's
   * password — this is the value printed in the maker's manual, nothing else. Null when
   * the recipe asks for none.
   */
  factoryPassword: string | null;
  /** What Laybel says when the steps do not match what the person sees. */
  ifItLooksDifferent: string;
};

const RESTARTS = "The phone restarts on its own — that's it. Put it down; the setup takes over from here.";

const RECIPES: ResetRecipe[] = [
  {
    family: "yealink_t_series",
    vendor: "yealink",
    headline: "Hold the OK button for 10 seconds",
    steps: [
      "Find the round OK button in the middle of the arrow keys.",
      "Hold it down for about 10 seconds — keep holding until the screen asks \"Reset to factory settings?\".",
      "Press OK once more to say yes.",
      RESTARTS,
    ],
    holdSeconds: 10,
    illustration: "hold_ok",
    // Izzy's own T42S, 2026-09-17: held OK, the phone asked, it reset, the robot registered it.
    confidence: "proven",
    factoryPassword: null,
    ifItLooksDifferent:
      "If nothing happens after 15 seconds, let go, wait five seconds and hold it again — some phones need it a second time. If it asks for a password instead, tell me and we'll try another way.",
  },
  {
    family: "yealink_dect_base",
    vendor: "yealink",
    headline: "Reset the base station from the handset menu",
    steps: [
      "On the cordless handset, open the menu and choose \"Settings\".",
      "Choose \"System Settings\", then \"Base Reset\".",
      "Type the PIN 0000 if it asks for one, then confirm.",
      "The base station's light blinks while it restarts — that's it. The setup takes over from here.",
    ],
    holdSeconds: null,
    illustration: "menu_password",
    confidence: "documented",
    factoryPassword: "0000",
    ifItLooksDifferent:
      "If the PIN 0000 is refused, your old provider changed it. There's a small reset button on the base itself — tell me and I'll show you where.",
  },
  {
    family: "grandstream_gxp_grp",
    vendor: "grandstream",
    headline: "Menu → System → Operations → Factory Reset",
    steps: [
      "Press the Menu button under the screen.",
      "Go to \"System\", then \"Operations\", then \"Factory Reset\".",
      "Press OK when it asks \"Are you sure?\".",
      RESTARTS,
    ],
    holdSeconds: null,
    illustration: "menu_path",
    confidence: "documented",
    factoryPassword: null,
    ifItLooksDifferent:
      "If \"Factory Reset\" is greyed out or asks for a password, your old provider locked the menu. Tell me — we'll unplug it and use the other way.",
  },
  {
    family: "grandstream_ata_ht",
    vendor: "grandstream",
    headline: "Hold the pinhole reset button for 7 seconds",
    steps: [
      "Find the tiny hole marked RESET on the back of the box.",
      "With a paper clip, press and hold the button inside for about 7 seconds while the box is powered on.",
      "Let go. The lights blink while it restarts — that's it. The setup takes over from here.",
    ],
    holdSeconds: 7,
    illustration: "pinhole",
    confidence: "documented",
    factoryPassword: null,
    ifItLooksDifferent:
      "If the lights never blink, hold it longer — a full 10 seconds — and make sure the power cable is in.",
  },
  {
    family: "polycom_vvx",
    vendor: "polycom",
    headline: "Settings → Advanced → Reset to Factory",
    steps: [
      "Press the Home button, then open \"Settings\".",
      "Choose \"Advanced\". It asks for a password — try 456, the factory one.",
      "Choose \"Administration Settings\", then \"Reset to Defaults\", then \"Reset to Factory\".",
      "Confirm with Yes.",
      RESTARTS,
    ],
    holdSeconds: null,
    illustration: "menu_password",
    confidence: "documented",
    factoryPassword: "456",
    ifItLooksDifferent:
      "If 456 is refused, your old provider changed it. Unplug the phone, plug it back in, and the moment the Polycom logo shows, hold the 1, 3 and 5 keys together until it asks for the MAC — tell me when you're there and I'll read it to you.",
  },
  {
    family: "fanvil_x_series",
    vendor: "fanvil",
    headline: "Menu → Advanced → Factory Reset",
    steps: [
      "Press Menu.",
      "Choose \"Advanced\". It asks for a password — try 123, the factory one.",
      "Choose \"Factory Reset\" (some phones call it \"Reset Config\") and confirm.",
      RESTARTS,
    ],
    holdSeconds: null,
    illustration: "menu_password",
    confidence: "inferred",
    factoryPassword: "123",
    ifItLooksDifferent:
      "Fanvil menus vary by model. Tell me exactly what your screen says and I'll walk you through it from there.",
  },
  {
    family: "cisco_desk",
    vendor: "cisco",
    headline: "Settings → Device Administration → Factory Reset",
    steps: [
      "Press the Settings button (the gear, or the sheet-of-paper icon on older phones).",
      "Look for \"Device Administration\" or \"Factory Reset\" and choose \"Factory Reset\".",
      "Confirm with OK.",
      RESTARTS,
    ],
    holdSeconds: null,
    illustration: "menu_path",
    confidence: "inferred",
    factoryPassword: null,
    ifItLooksDifferent:
      "Cisco phones differ a lot by model. Read me the menu names you see and I'll guide you.",
  },
  {
    family: "snom_d_series",
    vendor: "snom",
    headline: "Settings → Maintenance → Reset Values",
    steps: [
      "Press Settings.",
      "Choose \"Maintenance\", then \"Reset Values\". It may ask for the admin password — try 0000.",
      "Confirm.",
      RESTARTS,
    ],
    holdSeconds: null,
    illustration: "menu_password",
    confidence: "inferred",
    factoryPassword: "0000",
    ifItLooksDifferent:
      "If the password is refused, tell me — we'll do it from the phone's settings page instead.",
  },
  {
    family: "htek_uc",
    vendor: "htek",
    headline: "Menu → Settings → Advanced → Reset to factory",
    steps: [
      "Press Menu, then \"Settings\", then \"Advanced Settings\".",
      "Type the admin password if it asks — try admin, the factory one.",
      "Choose \"Reset to factory\" and confirm.",
      RESTARTS,
    ],
    holdSeconds: null,
    illustration: "menu_password",
    confidence: "inferred",
    factoryPassword: "admin",
    ifItLooksDifferent:
      "Tell me what your screen shows and I'll take it from there.",
  },
];

const GENERIC: ResetRecipe = {
  family: "generic",
  vendor: null,
  headline: "Let's find the reset together",
  steps: [
    "Most phones reset from a Settings or Menu button: look for \"Reset\", \"Factory Reset\" or \"Reset to defaults\".",
    "Some ask for a password — try the one printed in the phone's manual, or tell me the make and I'll look it up.",
    "Confirm when it asks. The phone restarts on its own — the setup takes over from here.",
  ],
  holdSeconds: null,
  illustration: "generic",
  confidence: "generic",
  factoryPassword: null,
  ifItLooksDifferent: "Read me the words on the screen and I'll guide you step by step.",
};

/** Every family, for the illustration library and the coverage test. */
export const RESET_RECIPES: readonly ResetRecipe[] = RECIPES;
export const GENERIC_RESET_RECIPE: ResetRecipe = GENERIC;

const NORM = (s: string | null | undefined) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * The recipe for a phone, from its maker and model. ⛔ The model decides within a
 * maker (a Yealink W-series base is not a T-series handset); a maker with no model
 * still gets its maker's commonest family, because "hold OK" is right for most Yealinks
 * and the generic card is right for none of them.
 */
export function resetRecipeFor(vendor: string | null | undefined, model: string | null | undefined): ResetRecipe {
  const slug = vendorSlugFor(vendor);
  const m = NORM(model);
  const by = (family: string) => RECIPES.find((r) => r.family === family) ?? GENERIC;
  switch (slug) {
    case "yealink":
      if (/^W\d|^W\d\dB|DECT|^CP\d/.test(m)) return /^CP\d/.test(m) ? GENERIC : by("yealink_dect_base");
      return by("yealink_t_series");
    case "grandstream":
      if (/^HT\d|^GXW|^DP\d/.test(m)) return /^DP\d/.test(m) ? GENERIC : by("grandstream_ata_ht");
      return by("grandstream_gxp_grp");
    case "polycom":
      return by("polycom_vvx");
    case "fanvil":
      return by("fanvil_x_series");
    case "cisco":
      return by("cisco_desk");
    case "snom":
      return by("snom_d_series");
    case "htek":
      return by("htek_uc");
    default:
      return GENERIC;
  }
}

/** Is the recipe certain enough that the screen may present it without a caveat? */
export function resetRecipeIsCertain(recipe: ResetRecipe): boolean {
  return recipe.confidence === "proven" || recipe.confidence === "documented";
}
