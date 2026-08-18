"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiGet, apiPut, apiPost, getPortalApiBaseUrl } from "../../../services/apiClient";

// ── Types ────────────────────────────────────────────────────────────────────

type CellMode = "" | "also" | "only";
type Extension = { displayName: string; extNumber: string; email: string; vmPassword: string; cellMode: CellMode; cellNumber: string; isOwner: boolean };

type PortingDetails = {
  carrier: string;
  numbers: string;
  accountNumber: string;
  nameOnAccount: string;
  // serviceAddress is the STREET line. Older saves stored the whole address in
  // it as one line — the server still parses that shape, so hydrating an old
  // draft into these fields is safe.
  serviceAddress: string;
  serviceCity: string;
  serviceState: string;
  serviceZip: string;
  // The carrier files wireless transfers differently, so we must ask.
  isMobile: boolean;
  portPin: string;
  loaFileName: string;
  billFileName: string;
};

type NumberKind = "local" | "tollfree" | "vanity";
type SearchMode = "starts" | "contains" | "ends";
type AvailableNumber = { number: string; location: string; sms: boolean; voice: boolean; inStock?: boolean; kind?: NumberKind };

type FormData = {
  companyName: string;
  firstName: string;
  lastName: string;
  mainPhone: string;
  // The 911 address, in pieces. `address` is the STREET LINE only — the
  // emergency registration at VoIP.ms refuses a single combined line (it wants
  // the street number, city, state and ZIP as separate fields), so this is
  // collected the same way the porting step already collects its address.
  address: string;
  addressCity: string;
  addressState: string;
  addressZip: string;
  mainEmail: string;
  billingEmail: string;
  numberChoice: "new" | "port" | "";
  selectedNumber: string;
  // What kind of number was picked — a toll-free/vanity number bills $15/month.
  numberKind: NumberKind | "";
  porting: PortingDetails;
  extensions: Extension[];
  smsEnabled: boolean;
};

const EMPTY_EXT: Extension = { displayName: "", extNumber: "", email: "", vmPassword: "", cellMode: "", cellNumber: "", isOwner: false };

/** Exactly one extension is the owner: keep the marked one, else the first. */
function withOneOwner(exts: Extension[]): Extension[] {
  if (!exts.length) return exts;
  const ownerIdx = Math.max(0, exts.findIndex((e) => e.isOwner));
  return exts.map((e, i) => ({ ...e, isOwner: i === ownerIdx }));
}

const EMPTY_FORM: FormData = {
  companyName: "", firstName: "", lastName: "",
  mainPhone: "", address: "", addressCity: "", addressState: "", addressZip: "", mainEmail: "", billingEmail: "",
  numberChoice: "", selectedNumber: "", numberKind: "",
  porting: { carrier: "", numbers: "", accountNumber: "", nameOnAccount: "", serviceAddress: "", serviceCity: "", serviceState: "", serviceZip: "", isMobile: false, portPin: "", loaFileName: "", billFileName: "" },
  extensions: [{ ...EMPTY_EXT, isOwner: true }],
  smsEnabled: false,
};

/**
 * Split a saved one-line address back into street / city / state / ZIP.
 *
 * Drafts started before the 911 address was collected in pieces hold the whole
 * thing in `address`. Without this they would reopen with three empty required
 * boxes and the customer would be blocked on a step they had already finished.
 * Mirrors parseServiceAddressLine on the server, which still handles anything
 * this misses.
 */
function splitSavedAddress(line: string): { address: string; city: string; state: string; zip: string } {
  let rest = String(line || "").replace(/\s+/g, " ").trim();
  const zipMatch = rest.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  const zip = zipMatch ? zipMatch[1] : "";
  if (zipMatch) rest = rest.slice(0, zipMatch.index).replace(/[\s,]+$/, "");
  const stateMatch = rest.match(/[,\s]([A-Za-z]{2})\.?\s*$/);
  const state = stateMatch ? stateMatch[1].toUpperCase() : "";
  if (stateMatch) rest = rest.slice(0, stateMatch.index).replace(/[\s,]+$/, "");
  const parts = rest.split(",").map((x) => x.trim()).filter(Boolean);
  const city = parts.length > 1 ? parts.pop()! : "";
  return { address: parts.join(", "), city, state, zip };
}

/** Cents → "$30.00". Never floats anywhere near money. */
function money(cents: number): string {
  const abs = Math.abs(Math.round(cents || 0));
  return `${cents < 0 ? "-" : ""}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const STEPS = [
  { id: "company",    label: "Company"    },
  { id: "contact",    label: "Contact"    },
  { id: "number",     label: "Your number"},
  { id: "extensions", label: "Extensions" },
  { id: "addons",     label: "Add-ons"    },
  { id: "review",     label: "Review"     },
  // Payment is LAST and mandatory: nothing is bought on the customer's behalf
  // until the card clears.
  { id: "payment",    label: "Payment"    },
];

// ── Inline SVG icons ─────────────────────────────────────────────────────────

function IconBuilding() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>); }
function IconContact() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>); }
function IconPhone() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.5-1.2a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/></svg>); }
function IconExtensions() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="9" width="4" height="6" rx="1"/><rect x="10" y="4" width="4" height="6" rx="1"/><rect x="10" y="14" width="4" height="6" rx="1"/><rect x="18" y="9" width="4" height="6" rx="1"/><path d="M6 12h4M14 7h4v5M14 17h4v-5"/></svg>); }
function IconSms() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>); }
function IconCheck() { return (<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>); }
function IconArrowRight({ size = 14 }: { size?: number }) { return (<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>); }
function IconArrowLeft({ size = 14 }: { size?: number }) { return (<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8H3M7 4L3 8l4 4"/></svg>); }
function IconTick({ size = 12 }: { size?: number }) { return (<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 8 7 12 13 4"/></svg>); }
function IconUpload() { return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>); }
function IconSun() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>); }
function IconMoon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>); }

// ── Validation helpers ───────────────────────────────────────────────────────

function isEmail(v: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()); }
/** Phone systems number people 101, 102, 103 — three digits up. A shorter one
 *  is accepted by VitalPBX and then vanishes from Connect: every directory
 *  read filters on `^\d{2,6}$`, so the extension exists, is billed, and is
 *  invisible. That is exactly what happened to one customer, whose only
 *  extension was literally numbered "1" — no phones showed anywhere and
 *  "a person" was greyed out in the IVR Studio. */
function isNumericExt(v: string) { return /^\d{3,6}$/.test(v.trim()); }
/** A single digit is what someone types when they think of it as "phone 1".
 *  Turn it into the real thing rather than rejecting them — 1 becomes 101. */
function promoteExtNumber(v: string): string {
  const d = v.trim();
  return /^\d$/.test(d) ? `10${d}` : d;
}

function validateStep(step: number, f: FormData): string | null {
  if (step === 0) {
    if (f.companyName.trim().length < 2) return "Company name must be at least 2 characters.";
    if (f.firstName.trim().length < 1) return "First name is required.";
    if (f.lastName.trim().length < 1) return "Last name is required.";
  }
  if (step === 1) {
    if (f.mainPhone.trim().length < 7) return "A valid phone number is required.";
    if (f.address.trim().length < 3) return "Street address is required.";
    // 911 sends help to this address, so it is collected in pieces and each
    // piece is checked — a half-filled address registers nothing.
    if (!/^\d/.test(f.address.trim())) return "Start the street address with the building number, like 123 Main St.";
    if (f.addressCity.trim().length < 2) return "City is required.";
    if (!/^[A-Za-z]{2}$/.test(f.addressState.trim())) return "Enter the 2-letter state, like NY.";
    if (!/^\d{5}$/.test(f.addressZip.trim())) return "Enter the 5-digit ZIP code.";
    if (!isEmail(f.mainEmail)) return "A valid main email is required.";
    // Billing email is optional — when blank we bill to the main email.
    if (f.billingEmail.trim() && !isEmail(f.billingEmail)) return "The billing email doesn't look right — fix it or leave it blank.";
  }
  if (step === 2) {
    if (!f.numberChoice) return "Please choose how you'd like to set up your number.";
    if (f.numberChoice === "new" && !f.selectedNumber) return "Please pick a number from the list.";
    if (f.numberChoice === "port") {
      if (f.porting.numbers.trim().length < 7) return "Enter the number you'd like to bring over.";
      if (f.porting.carrier.trim().length < 2) return "Your current carrier is required.";
      if (f.porting.accountNumber.trim().length < 1) return "Your carrier account number is required.";
      // The carrier rejects transfers whose address doesn't match their file —
      // collect it in pieces so it can be filed exactly.
      if (f.porting.serviceAddress.trim().length < 3) return "The street address from your carrier bill is required.";
      if (f.porting.serviceCity.trim().length < 2) return "The city from your carrier bill is required.";
      if (!/^[A-Za-z]{2}$/.test(f.porting.serviceState.trim())) return "Enter the 2-letter state (like NY) from your carrier bill.";
      if (!/^\d{5}$/.test(f.porting.serviceZip.trim())) return "Enter the 5-digit ZIP code from your carrier bill.";
      if (f.porting.isMobile && !f.porting.portPin.trim()) return "Cell number transfers need the transfer PIN from your current carrier.";
    }
  }
  if (step === 3) {
    for (const ext of f.extensions) {
      if (ext.displayName.trim().length < 1) return "Each extension needs a name.";
      if (!isNumericExt(ext.extNumber)) {
        return `Extension number "${ext.extNumber || "(empty)"}" won't work — use at least three digits, like 101.`;
      }
      if (ext.cellMode && ext.cellNumber.replace(/\D/g, "").replace(/^1/, "").length !== 10) {
        return `Enter a full cell phone number for ${ext.displayName.trim() || "extension " + (ext.extNumber || "?")}.`;
      }
      // Email is optional, but a typed one must be valid — catching it here
      // instead of letting the final submit reject it on the review step.
      if (ext.email.trim() && !isEmail(ext.email)) {
        return `The email for ${ext.displayName.trim() || "extension " + (ext.extNumber || "?")} doesn't look right — fix it or leave it blank.`;
      }
    }
    const nums = f.extensions.map((e) => e.extNumber.trim());
    if (new Set(nums).size !== nums.length) return "Extension numbers must be unique.";
    // The owner becomes the account admin — without an email there is no
    // login to attach that to, and the account would have nobody in charge.
    const owner = f.extensions.find((e) => e.isOwner) || f.extensions[0];
    if (owner && !owner.email.trim()) {
      return `${owner.displayName.trim() || "The owner"} is the account owner and needs an email address — that's where the admin login goes.`;
    }
  }
  return null;
}

function areaCodeFrom(phone: string): string {
  const d = phone.replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return t.slice(0, 3);
}

/** Phone-keypad letters → digits ("PIZZA" → "74992") for the vanity preview. */
function vanityToDigits(word: string): string {
  const keypad: Record<string, string> = {
    a: "2", b: "2", c: "2", d: "3", e: "3", f: "3", g: "4", h: "4", i: "4",
    j: "5", k: "5", l: "5", m: "6", n: "6", o: "6", p: "7", q: "7", r: "7", s: "7",
    t: "8", u: "8", v: "8", w: "9", x: "9", y: "9", z: "9",
  };
  return word.toLowerCase().split("").map((c) => (/[0-9]/.test(c) ? c : keypad[c] || "")).join("").slice(0, 7);
}

// ── Main component ───────────────────────────────────────────────────────────

export default function PublicOnboardingPage({ params }: { params: { token: string } }) {
  const token = params.token;

  const [loading, setLoading] = useState(true);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);

  const [stepError, setStepError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "retrying" | "failed">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on every new save (and on submit) so an in-flight retry loop from
  // an older edit knows to stand down instead of clobbering the indicator.
  const saveSeq = useRef(0);
  // True from the moment an edit is made until the server confirms it —
  // drives the "you have unsaved changes" warning on close/refresh.
  const unsavedRef = useRef(false);
  // The form was submitted in ANOTHER tab: /save answers 409 and every edit
  // here is silently lost — so stop the wizard with a blocking banner.
  const [conflict, setConflict] = useState(false);

  // Number search state
  const [numbers, setNumbers] = useState<AvailableNumber[]>([]);
  const [numbersLoading, setNumbersLoading] = useState(false);
  const [numbersQuery, setNumbersQuery] = useState("");
  const [numbersError, setNumbersError] = useState<string | null>(null);
  // Local vs toll-free tab, where in the number the digits should sit, and the
  // "spell a word" input (toll-free vanity search).
  const [numbersTab, setNumbersTab] = useState<"local" | "tollfree">("local");
  const [searchMode, setSearchMode] = useState<SearchMode>("starts");
  const [vanityWord, setVanityWord] = useState("");

  // Porting: portability check + document uploads
  const [portability, setPortability] = useState<"idle" | "checking" | "portable" | "unknown">("idle");
  const [uploading, setUploading] = useState<{ loa: boolean; bill: boolean }>({ loa: false, bill: false });

  // Review step: the itemized monthly price, fetched from the server so the
  // number shown is computed by the SAME pricing code as the first invoice.
  type QuoteLine = { key: string; label: string; quantity: number; unitCents: number; totalCents: number; note?: string };
  const [quote, setQuote] = useState<{ lines: QuoteLine[]; monthlyTotalCents: number } | null>(null);
  const [quoteFailed, setQuoteFailed] = useState(false);

  // ── Token validation ──────────────────────────────────────────────────────
  useEffect(() => {
    async function validate() {
      try {
        const r = await apiGet<{ ok: boolean; exists?: boolean; submission?: { id: string; currentStep: number | string | null; answers: any } }>(
          `/onboarding/${encodeURIComponent(token)}/validate`,
        );
        if (r.exists === false) { setTokenError("not_active"); return; }
        const a = r.submission?.answers || {};
        if (a.submit || a.company || a.contact || a.phone || a.extensions || a.addons) {
          // A draft from before the address was collected in pieces keeps the
          // whole thing on one line — split it so the customer does not come
          // back to empty required boxes.
          const savedStreet = a.submit?.address || a.contact?.address || "";
          const savedCity = a.submit?.addressCity || a.contact?.addressCity || "";
          const legacy = savedStreet && !savedCity ? splitSavedAddress(savedStreet) : null;
          setForm((prev) => ({
            ...prev,
            companyName:   a.submit?.companyName   || a.company?.companyName   || prev.companyName,
            firstName:     a.submit?.firstName     || a.company?.firstName     || prev.firstName,
            lastName:      a.submit?.lastName      || a.company?.lastName      || prev.lastName,
            mainPhone:     a.submit?.mainPhone     || a.contact?.mainPhone     || prev.mainPhone,
            address:       (legacy?.address || savedStreet)                    || prev.address,
            addressCity:   savedCity              || legacy?.city  || prev.addressCity,
            addressState:  a.submit?.addressState  || a.contact?.addressState  || legacy?.state || prev.addressState,
            addressZip:    a.submit?.addressZip    || a.contact?.addressZip    || legacy?.zip   || prev.addressZip,
            mainEmail:     a.submit?.mainEmail     || a.contact?.mainEmail     || prev.mainEmail,
            billingEmail:  a.submit?.billingEmail  || a.contact?.billingEmail  || prev.billingEmail,
            numberChoice:  a.phone?.choice         || prev.numberChoice,
            selectedNumber:a.phone?.selectedNumber || prev.selectedNumber,
            numberKind:    a.phone?.numberKind     || prev.numberKind,
            porting:       { ...prev.porting, ...(a.phone?.details || {}) },
            extensions:    Array.isArray(a.extensions) && a.extensions.length ? withOneOwner(a.extensions.map((e: any) => ({ ...EMPTY_EXT, ...e }))) : prev.extensions,
            smsEnabled:    a.addons?.smsEnabled    ?? prev.smsEnabled,
          }));
        }
        // The API stores the step as a string — parse either form.
        const savedStep = Number(r.submission?.currentStep ?? 0) || 0;
        if (savedStep > 0 && savedStep < STEPS.length) setStep(savedStep);
      } catch {
        setTokenError("not_active");
      } finally {
        setLoading(false);
      }
    }
    validate();
  }, [token]);

  // ── Journey beacons ─────────────────────────────────────────────────────────
  // Everything the customer does becomes one plain-English line on the
  // sign-up's timeline (admin page + the owner's report email): steps reached
  // with time spent, going back, the exact message that blocked them, number
  // searches. Fire-and-forget; a lost beacon must never affect the wizard.
  const stepEnteredAt = useRef<number>(Date.now());
  const track = useCallback((kind: string, payload: Record<string, unknown> = {}) => {
    void apiPost(`/onboarding/${encodeURIComponent(token)}/track`, { kind, ...payload }).catch(() => { /* silent */ });
  }, [token]);
  const secondsOnStep = () => Math.min(86_400, Math.max(0, Math.round((Date.now() - stepEnteredAt.current) / 1000)));

  // ── Autosave ────────────────────────────────────────────────────────────────
  // A failed save is never silent: it retries 3 times with backoff (a phone
  // dropping Wi-Fi for a moment must not lose answers), shows "Not saved" while
  // it does, and arms the leave-page warning until the server has the data.
  const scheduleAutosave = useCallback((f: FormData, currentStep: number) => {
    unsavedRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const seq = ++saveSeq.current;
    saveTimer.current = setTimeout(async () => {
      setSaveState("saving");
      for (let attempt = 0; ; attempt++) {
        try {
          await apiPut(`/onboarding/${encodeURIComponent(token)}/save`, {
            currentStep,
            answers: {
              company:    { companyName: f.companyName, firstName: f.firstName, lastName: f.lastName },
              contact:    { mainPhone: f.mainPhone, address: f.address, addressCity: f.addressCity, addressState: f.addressState, addressZip: f.addressZip, mainEmail: f.mainEmail, billingEmail: f.billingEmail },
              phone:      { choice: f.numberChoice, selectedNumber: f.selectedNumber, numberKind: f.numberKind || undefined, details: f.porting },
              extensions: f.extensions,
              addons:     { smsEnabled: f.smsEnabled },
            },
          });
          if (seq !== saveSeq.current) return; // a newer save owns the state now
          unsavedRef.current = false;
          setSaveState("saved");
          setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
          return;
        } catch (e) {
          if (seq !== saveSeq.current) return;
          if (e instanceof ApiError && e.status === 409) {
            // Submitted in another tab — retrying can never succeed.
            unsavedRef.current = false;
            setConflict(true);
            return;
          }
          if (attempt >= 3) {
            setSaveState("failed");
            return;
          }
          setSaveState("retrying");
          await new Promise((r) => setTimeout(r, 1200 * 2 ** attempt));
        }
      }
    }, 900);
  }, [token]);

  // Unsaved answers + closing the tab = lost work; let the browser ask first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!unsavedRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  function updateForm(patch: Partial<FormData>) {
    setForm((prev) => { const next = { ...prev, ...patch }; scheduleAutosave(next, step); return next; });
    setStepError(null);
  }

  // ── Number search ─────────────────────────────────────────────────────────
  const searchNumbers = useCallback(async (
    query: string,
    opts: { tab?: "local" | "tollfree"; mode?: SearchMode; vanity?: string } = {},
  ) => {
    setNumbersLoading(true);
    setNumbersError(null);
    const tab = opts.tab || "local";
    const detail = opts.vanity
      ? `vanity "${opts.vanity}"`
      : `${tab === "tollfree" ? "toll-free " : ""}${query || "(blank)"}${opts.mode ? ` (${opts.mode})` : ""}`;
    try {
      // VoIP.ms availability search regularly takes 15-25s — far beyond the
      // client's default 10s timeout, which made this look like "no numbers".
      const params = new URLSearchParams({ q: query });
      params.set("type", tab);
      if (opts.mode && tab === "local") params.set("mode", opts.mode);
      if (opts.vanity) params.set("vanity", opts.vanity);
      const r = await apiGet<{ numbers?: AvailableNumber[] }>(
        `/onboarding/${encodeURIComponent(token)}/numbers?${params.toString()}`,
        undefined,
        { timeoutMs: 45_000 },
      );
      const list = Array.isArray(r.numbers) ? r.numbers : [];
      setNumbers(list);
      track("number_search", { detail, count: list.length });
    } catch {
      setNumbers([]);
      // Honest copy: Continue is blocked until a number is picked, so don't
      // promise "we'll assign one" — offer the retry that actually helps.
      setNumbersError("We couldn't load available numbers just now — the number service may be briefly busy. Tap Search to try again in a few seconds.");
      track("number_search", { detail, count: -1 });
    } finally {
      setNumbersLoading(false);
    }
  }, [token, track]);

  // Auto-search when the customer chooses "new number".
  useEffect(() => {
    if (step === 2 && form.numberChoice === "new" && numbers.length === 0 && !numbersLoading && !numbersError) {
      const seed = numbersTab === "local" ? areaCodeFrom(form.mainPhone) || "" : "";
      setNumbersQuery(seed);
      searchNumbers(seed, { tab: numbersTab, mode: searchMode });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, form.numberChoice]);

  // Switching Local ↔ Toll-free: clear the old tab's results and search fresh.
  function switchNumbersTab(tab: "local" | "tollfree") {
    if (tab === numbersTab) return;
    setNumbersTab(tab);
    setNumbers([]);
    setNumbersError(null);
    setVanityWord("");
    const seed = tab === "local" ? areaCodeFrom(form.mainPhone) || "" : "";
    setNumbersQuery(seed);
    searchNumbers(seed, { tab, mode: searchMode });
  }

  // Debounced portability check when the customer is porting a number in.
  useEffect(() => {
    if (step !== 2 || form.numberChoice !== "port") return;
    const digits = form.porting.numbers.replace(/\D/g, "");
    if (digits.length < 10) { setPortability("idle"); return; }
    let cancelled = false;
    setPortability("checking");
    const t = setTimeout(async () => {
      try {
        const r = await apiGet<{ portable: boolean | null }>(
          `/onboarding/${encodeURIComponent(token)}/portability?number=${encodeURIComponent(digits)}`,
          undefined,
          { timeoutMs: 30_000 },
        );
        if (!cancelled) {
          setPortability(r.portable === true ? "portable" : "unknown");
          track("portability", { detail: `${digits} — ${r.portable === true ? "can be transferred" : "couldn't confirm, told them we'd handle it"}` });
        }
      } catch {
        if (!cancelled) setPortability("unknown");
      }
    }, 700);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.porting.numbers, form.numberChoice, step]);

  // Fetch the price on entering the review step. The wizard passes its live
  // extension count + SMS flag — autosave is debounced, so the server's stored
  // answers can be a moment behind what's on this screen.
  useEffect(() => {
    if (step !== 5) return;
    let cancelled = false;
    setQuote(null);
    setQuoteFailed(false);
    const extCount = form.extensions.filter((e) => e.displayName.trim() && e.extNumber.trim()).length;
    // The kind rides along like extensions/sms: apply-number is fire-and-forget
    // and autosave debounced, so the server's stored answers can lag the screen
    // — and the toll-free $15 line must never lag the review price.
    const kindParam = form.numberChoice === "new" ? `&numberKind=${form.numberKind || "local"}` : "";
    apiGet<{ lines: QuoteLine[]; monthlyTotalCents: number }>(
      `/onboarding/${encodeURIComponent(token)}/quote?extensions=${extCount}&sms=${form.smsEnabled ? 1 : 0}${kindParam}`,
    )
      .then((r) => { if (!cancelled) setQuote({ lines: r.lines || [], monthlyTotalCents: r.monthlyTotalCents || 0 }); })
      .catch(() => { if (!cancelled) setQuoteFailed(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, token]);

  async function uploadPortDoc(kind: "loa" | "bill", file: File) {
    setStepError(null);
    setUploading((u) => ({ ...u, [kind]: true }));
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${getPortalApiBaseUrl()}/onboarding/${encodeURIComponent(token)}/upload-bill?kind=${kind}`, { method: "POST", body: fd, cache: "no-store" });
      if (!res.ok) throw new Error("upload_failed");
      // Functional update: uploading the authorization and the bill back to
      // back used to lose the first filename (stale closure over `form`).
      const field = kind === "loa" ? "loaFileName" : "billFileName";
      setForm((prev) => {
        const next = { ...prev, porting: { ...prev.porting, [field]: file.name } };
        scheduleAutosave(next, step);
        return next;
      });
    } catch {
      setStepError("That file couldn't upload. Please check the file and try again.");
    } finally {
      setUploading((u) => ({ ...u, [kind]: false }));
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function goNext() {
    const err = validateStep(step, form);
    if (err) {
      setStepError(err);
      track("validation_blocked", { step: STEPS[step].label, detail: err });
      return;
    }
    setStepError(null);
    // Leaving the number step: start setting up their number in the background
    // (buy / route / temporary number for ports). Fire-and-forget — the customer
    // keeps moving through the wizard while it happens.
    if (step === 2) {
      void apiPost(`/onboarding/${encodeURIComponent(token)}/apply-number`, {
        choice: form.numberChoice,
        selectedNumber: form.numberChoice === "new" ? form.selectedNumber : undefined,
        numberKind: form.numberChoice === "new" ? form.numberKind || "local" : undefined,
        porting: form.numberChoice === "port" ? form.porting : undefined,
        smsEnabled: form.smsEnabled,
        companyName: form.companyName,
      }).catch(() => { /* retried on final submit */ });
    }
    const next = step + 1;
    track("step_viewed", { step: STEPS[next].label, fromStep: STEPS[step].label, seconds: secondsOnStep() });
    stepEnteredAt.current = Date.now();
    setStep(next);
    scheduleAutosave(form, next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function goBack() {
    setStepError(null);
    setStep((s) => {
      const prev = Math.max(0, s - 1);
      if (prev !== s) track("went_back", { step: STEPS[prev].label, fromStep: STEPS[s].label });
      stepEnteredAt.current = Date.now();
      return prev;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  /**
   * Saves everything, then moves to payment. It deliberately does NOT finish
   * the sign-up: the number and the phone system are only bought once the card
   * clears, so this is the last step that costs nothing.
   */
  // ── Checkout ──────────────────────────────────────────────────────────────
  // The wizard doesn't render a payment form. Reaching this step asks the
  // server to create the tenant and the first invoice in the background, then
  // sends the customer to /pay/invoice/[token] — the same checkout page every
  // customer pays invoices on. The card fields, the receipt email and the
  // "Payment received" screen all live THERE; a second copy of them here was
  // deleted on Izzy's instruction, and rightly: it was the copy nobody used.
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const checkoutFired = useRef(false);

  const startCheckout = useCallback(async () => {
    if (checkoutFired.current) return;
    checkoutFired.current = true;
    setCheckoutError(null);
    try {
      // Preparing checkout creates the tenant + first invoice server-side and
      // can legitimately be slow — the default 10s client timeout made a slow
      // prepare look failed, and the retry is exactly what used to mint a
      // second invoice.
      const r = await apiPost<{ payPath: string; alreadyPaid: boolean }>(
        `/onboarding/${encodeURIComponent(token)}/checkout`,
        {},
        undefined,
        { timeoutMs: 30_000 },
      );
      // Already paid (e.g. back-button after paying): straight to progress.
      window.location.href = r.alreadyPaid
        ? `/onboarding/${encodeURIComponent(token)}/success`
        : r.payPath;
    } catch (e: any) {
      checkoutFired.current = false; // allow a retry
      // ApiError carries the server's friendly text in .body — .message is
      // "code: text" and rendered raw codes like "charges_disabled: …".
      setCheckoutError(e?.body?.message || "We couldn't prepare your checkout. Please try again.");
    }
  }, [token]);

  useEffect(() => {
    if (step === 6) void startCheckout();
  }, [step, startCheckout]);

  // Back-button traps: coming BACK from the pay page can restore this page
  // from the bfcache exactly as it was left — checkoutFired stuck true, so the
  // step-6 auto-fire never ran again and the customer stared at a spinner
  // with no button. Same trap re-entering payment from the review step.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) checkoutFired.current = false;
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
  useEffect(() => {
    if (step !== 6) checkoutFired.current = false;
  }, [step]);

  async function handleSubmit() {
    setSubmitError(null);
    // Re-check every step before launching: autosaved data can predate newer
    // validation, and fields edited on earlier steps shouldn't fail server-side.
    for (let s = 0; s <= 3; s++) {
      const err = validateStep(s, form);
      if (err) {
        setSubmitError(err);
        track("validation_blocked", { step: STEPS[5].label, detail: err });
        return;
      }
    }
    setSubmitting(true);
    try {
      await apiPost(`/onboarding/${encodeURIComponent(token)}/submit`, {
        companyName:        form.companyName,
        contactFirstName:   form.firstName,
        contactLastName:    form.lastName,
        address:            form.address,
        addressCity:        form.addressCity,
        addressState:       form.addressState.trim().toUpperCase(),
        addressZip:         form.addressZip,
        mainPhone:          form.mainPhone,
        mainEmail:          form.mainEmail,
        // No separate billing contact? Bills go to the main email.
        billingEmail:       form.billingEmail.trim() || form.mainEmail,
        phoneNumberChoice:  form.numberChoice || undefined,
        selectedNumber:     form.numberChoice === "new" ? form.selectedNumber || undefined : undefined,
        numberKind:         form.numberChoice === "new" ? form.numberKind || "local" : undefined,
        porting:            form.numberChoice === "port" ? form.porting : undefined,
        smsEnabled:         form.smsEnabled,
        extensions:         form.extensions
          .filter((e) => e.displayName.trim() && e.extNumber.trim())
          .map((e) => ({
            displayName: e.displayName.trim(),
            extNumber: e.extNumber.trim(),
            email: e.email.trim() || undefined,
            vmPassword: e.vmPassword.trim() || undefined,
            cellMode: e.cellMode || undefined,
            cellNumber: e.cellMode ? e.cellNumber.replace(/\D/g, "").replace(/^1/, "") : undefined,
            isOwner: e.isOwner || undefined,
          })),
      });
      // Saved and locked — a still-pending autosave would now 409 against the
      // submitted row and read as a false "another tab" conflict. Everything
      // it carried is inside the submit that just succeeded.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveSeq.current++;
      unsavedRef.current = false;
      // On to the payment step, which hands off to the real checkout page.
      // /success is where the PAY page lands afterwards; going there from
      // here skipped payment entirely.
      track("step_viewed", { step: STEPS[6].label, fromStep: STEPS[5].label, seconds: secondsOnStep() });
      stepEnteredAt.current = Date.now();
      setStep(6);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("write_blocked") || msg.includes("already been submitted")) {
        // Already submitted — e.g. they came back after an interrupted
        // checkout. Everything is saved; what's missing is the payment, so
        // carry on to it. Checkout itself knows how to treat a paid row.
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveSeq.current++;
        unsavedRef.current = false;
        setStep(6);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        setSubmitError(msg || "Submission failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── Extension + upload + theme helpers ────────────────────────────────────
  function addExt() { updateForm({ extensions: withOneOwner([...form.extensions, { ...EMPTY_EXT }]) }); }
  // Removing the owner row hands ownership to the first remaining extension.
  function removeExt(i: number) { updateForm({ extensions: withOneOwner(form.extensions.filter((_, idx) => idx !== i)) }); }
  function updateExt(i: number, patch: Partial<Extension>) { updateForm({ extensions: form.extensions.map((e, idx) => idx === i ? { ...e, ...patch } : e) }); }
  function setOwnerExt(i: number) { updateForm({ extensions: form.extensions.map((e, idx) => ({ ...e, isOwner: idx === i })) }); }

  function toggleTheme() {
    const shell = document.querySelector(".ob-shell");
    if (!shell) return;
    const cur = shell.getAttribute("data-ob-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    shell.setAttribute("data-ob-theme", next);
    try { window.localStorage.setItem("ob-theme", next); } catch { /* ignore */ }
    setThemeLabel(next);
  }
  const [themeLabel, setThemeLabel] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const shell = document.querySelector(".ob-shell");
    const cur = shell?.getAttribute("data-ob-theme");
    if (cur === "light" || cur === "dark") setThemeLabel(cur);
    else setThemeLabel(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, [loading]);

  // ── Render guards ─────────────────────────────────────────────────────────
  if (loading) {
    return (<div className="ob-loading"><div className="ob-spinner" /><span>Loading your setup…</span></div>);
  }
  if (tokenError) {
    return (
      <div className="ob-invalid-wrap">
        <div className="ob-invalid-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div className="ob-invalid-title">This onboarding link is not active</div>
        <p className="ob-invalid-body">Please contact your Connect Communications contact for a new link.</p>
        <p className="ob-invalid-support">Need help? <a href="mailto:support@connectcomunications.com" className="ob-invalid-link">support@connectcomunications.com</a></p>
      </div>
    );
  }

  if (conflict) {
    // The form was submitted from another tab. Anything typed here can no
    // longer be saved — say so loudly instead of letting edits vanish.
    return (
      <div className="ob-invalid-wrap">
        <div className="ob-invalid-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        </div>
        <div className="ob-invalid-title">This sign-up was already submitted in another tab</div>
        <p className="ob-invalid-body">
          Everything submitted there is safe — but changes made on <b>this</b> screen can&apos;t be saved
          any more. Reload to pick up exactly where the other tab left off.
        </p>
        <button className="ob-btn-next" onClick={() => window.location.reload()}>Reload this page</button>
      </div>
    );
  }

  const stepIcons = [IconBuilding, IconContact, IconPhone, IconExtensions, IconSms, IconCheck, IconCheck];
  const StepIcon = stepIcons[step] ?? IconCheck;
  const eyebrows = ["About you", "Reach you", "Your number", "Your team", "Extras", "Confirm", "Payment"];
  const stepTitles = ["Tell us about your company", "How can we reach you?", "Choose your phone number", "Add your team's extensions", "Business messaging", "Review & launch", "Your card"];
  const stepSubtitles = [
    "We'll use this to build your account and phone system.",
    "Your billing contact can be different from your main contact.",
    "Bring your existing number, or grab a fresh one — set up instantly.",
    "Each person gets their own extension. We create them all automatically.",
    "Turn on texting for your business number — you can change this anytime.",
    "Here's everything. Next you'll add a card — nothing is bought until then.",
    "Your card stays on file — that's how each month is paid. Nothing has been bought yet.",
  ];

  return (
    <>
      {/* Header */}
      <div className="ob-header">
        <div className="ob-logo">
          <div className="ob-logo-mark">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="3" fill="rgba(255,255,255,0.95)"/>
              <circle cx="3" cy="5" r="1.5" fill="rgba(255,255,255,0.6)"/><circle cx="13" cy="5" r="1.5" fill="rgba(255,255,255,0.6)"/>
              <circle cx="3" cy="11" r="1.5" fill="rgba(255,255,255,0.6)"/><circle cx="13" cy="11" r="1.5" fill="rgba(255,255,255,0.6)"/>
              <line x1="8" y1="8" x2="3" y2="5" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/><line x1="8" y1="8" x2="13" y2="5" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/>
              <line x1="8" y1="8" x2="3" y2="11" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/><line x1="8" y1="8" x2="13" y2="11" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8"/>
            </svg>
          </div>
          <span className="ob-logo-text">Connect</span>
        </div>
        <div className="ob-header-tools">
          <div className="ob-save-indicator" style={{ opacity: saveState !== "idle" ? 1 : 0 }}>
            {saveState === "saving" && (<><div className="ob-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /><span>Saving…</span></>)}
            {saveState === "saved" && (<><div className="ob-save-dot" /><span>Saved</span></>)}
            {saveState === "retrying" && (<><div className="ob-spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /><span className="ob-save-warn">Not saved — retrying…</span></>)}
            {saveState === "failed" && (<><div className="ob-save-dot ob-save-dot-err" /><span className="ob-save-warn">Not saved</span></>)}
          </div>
          <button className="ob-theme-toggle" onClick={toggleTheme} aria-label="Toggle light or dark theme">
            {themeLabel === "dark" ? <IconMoon /> : <IconSun />} {themeLabel === "dark" ? "Dark" : "Light"}
          </button>
        </div>
      </div>

      {/* Progress */}
      <div className="ob-progress">
        <div className="ob-progress-track">
          {STEPS.map((s, i) => (<div key={s.id} className={`ob-progress-step${i < step ? " done" : i === step ? " active" : ""}`} />))}
        </div>
        <div className="ob-progress-label">
          <span className="ob-progress-label-current">{STEPS[step]?.label}</span>
          <span>Step {step + 1} of {STEPS.length}</span>
        </div>
      </div>

      {/* Card */}
      <div className="ob-card" key={step}>
        <div className="ob-illustration"><StepIcon /></div>
        <div className="ob-step-eyebrow">{eyebrows[step]}</div>
        <h1 className="ob-step-title">{stepTitles[step]}</h1>
        <p className="ob-step-subtitle">{stepSubtitles[step]}</p>

        {/* Step 0: Company */}
        {step === 0 && (
          <div>
            <div className="ob-field">
              <label className="ob-label">Company name</label>
              <input className="ob-input" placeholder="Acme Corp" value={form.companyName} onChange={(e) => updateForm({ companyName: e.target.value })} />
            </div>
            <div className="ob-field-row">
              <div><label className="ob-label">First name</label><input className="ob-input" placeholder="Jane" value={form.firstName} onChange={(e) => updateForm({ firstName: e.target.value })} /></div>
              <div><label className="ob-label">Last name</label><input className="ob-input" placeholder="Smith" value={form.lastName} onChange={(e) => updateForm({ lastName: e.target.value })} /></div>
            </div>
          </div>
        )}

        {/* Step 1: Contact */}
        {step === 1 && (
          <div>
            <div className="ob-field"><label className="ob-label">Main phone number</label><input className="ob-input" placeholder="(555) 000-0000" value={form.mainPhone} onChange={(e) => updateForm({ mainPhone: e.target.value })} /></div>
            <div className="ob-field">
              <label className="ob-label">Street address</label>
              <input className="ob-input" placeholder="123 Main St, Suite 200" value={form.address} onChange={(e) => updateForm({ address: e.target.value })} />
              <div className="ob-field-hint">This is the address emergency services are sent to when someone dials 911 from your phones. Give the address where the phones actually are.</div>
            </div>
            <div className="ob-field-row ob-field-row--city">
              <div><label className="ob-label">City</label><input className="ob-input" placeholder="Monsey" value={form.addressCity} onChange={(e) => updateForm({ addressCity: e.target.value })} /></div>
              <div><label className="ob-label">State</label><input className="ob-input" placeholder="NY" maxLength={2} value={form.addressState} onChange={(e) => updateForm({ addressState: e.target.value.toUpperCase() })} /></div>
              <div><label className="ob-label">ZIP code</label><input className="ob-input" placeholder="10952" maxLength={5} value={form.addressZip} onChange={(e) => updateForm({ addressZip: e.target.value })} /></div>
            </div>
            <div className="ob-field-row">
              <div><label className="ob-label">Primary email</label><input className="ob-input" type="email" placeholder="jane@acme.com" value={form.mainEmail} onChange={(e) => updateForm({ mainEmail: e.target.value })} /></div>
              <div><label className="ob-label">Billing email<span className="ob-label-optional">optional</span></label><input className="ob-input" type="email" placeholder="billing@acme.com" value={form.billingEmail} onChange={(e) => updateForm({ billingEmail: e.target.value })} /></div>
            </div>
          </div>
        )}

        {/* Step 2: Your number */}
        {step === 2 && (
          <div>
            <div className="ob-choice-group" style={{ marginBottom: form.numberChoice ? 20 : 0 }}>
              <div className={`ob-choice${form.numberChoice === "new" ? " selected" : ""}`} tabIndex={0} onClick={() => updateForm({ numberChoice: "new" })}
                onKeyDown={(e) => e.key === "Enter" && updateForm({ numberChoice: "new" })}>
                <div className="ob-choice-radio"><div className="ob-choice-radio-dot" /></div>
                <div className="ob-choice-body"><div className="ob-choice-label">Get a new number</div><div className="ob-choice-desc">Pick a local or toll-free number and it's live in minutes.</div></div>
                <div className="ob-choice-badge">Instant</div>
              </div>
              <div className={`ob-choice${form.numberChoice === "port" ? " selected" : ""}`} tabIndex={0} onClick={() => updateForm({ numberChoice: "port" })}
                onKeyDown={(e) => e.key === "Enter" && updateForm({ numberChoice: "port" })}>
                <div className="ob-choice-radio"><div className="ob-choice-radio-dot" /></div>
                <div className="ob-choice-body"><div className="ob-choice-label">Bring my existing number</div><div className="ob-choice-desc">Keep the number you have — we handle the whole transfer.</div></div>
              </div>
            </div>

            {/* New number: local / toll-free tabs + search + pick */}
            {form.numberChoice === "new" && (
              <div>
                <div className="ob-choice-group" style={{ marginBottom: 14, display: "flex", gap: 8 }}>
                  <button
                    className={`ob-btn-ghost${numbersTab === "local" ? " ob-tab-active" : ""}`}
                    style={numbersTab === "local" ? { borderColor: "#2f6bff", color: "#2f6bff", fontWeight: 700 } : undefined}
                    onClick={() => switchNumbersTab("local")}
                  >
                    Local number
                  </button>
                  <button
                    className={`ob-btn-ghost${numbersTab === "tollfree" ? " ob-tab-active" : ""}`}
                    style={numbersTab === "tollfree" ? { borderColor: "#2f6bff", color: "#2f6bff", fontWeight: 700 } : undefined}
                    onClick={() => switchNumbersTab("tollfree")}
                  >
                    Toll-free · $15/mo
                  </button>
                </div>

                {numbersTab === "local" ? (
                  <>
                    <label className="ob-label">Search by digits</label>
                    <div className="ob-searchbar">
                      {/* Where the digits should sit — VoIP.ms searches all three ways. */}
                      <select
                        className="ob-input"
                        style={{ maxWidth: 140, flexShrink: 0 }}
                        value={searchMode}
                        onChange={(e) => setSearchMode(e.target.value as SearchMode)}
                        aria-label="Where the digits appear in the number"
                      >
                        <option value="starts">Starts with</option>
                        <option value="contains">Contains</option>
                        <option value="ends">Ends with</option>
                      </select>
                      <input className="ob-input" placeholder="e.g. 305" value={numbersQuery}
                        onChange={(e) => setNumbersQuery(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !numbersLoading && searchNumbers(numbersQuery, { tab: "local", mode: searchMode })} />
                      {/* Disabled while a search runs: each one can take 20s+, and
                          impatient re-clicks used to stack concurrent requests. */}
                      <button className="ob-btn-ghost" disabled={numbersLoading} onClick={() => searchNumbers(numbersQuery, { tab: "local", mode: searchMode })}>
                        {numbersLoading ? "Searching…" : "Search"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="ob-label">Search toll-free numbers</label>
                    <div className="ob-searchbar">
                      <input className="ob-input" placeholder="Digits, e.g. 833 or 2255" value={numbersQuery}
                        onChange={(e) => setNumbersQuery(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !numbersLoading && searchNumbers(numbersQuery, { tab: "tollfree" })} />
                      <button className="ob-btn-ghost" disabled={numbersLoading} onClick={() => searchNumbers(numbersQuery, { tab: "tollfree" })}>
                        {numbersLoading ? "Searching…" : "Search"}
                      </button>
                    </div>
                    <label className="ob-label" style={{ marginTop: 12 }}>Or spell a word<span className="ob-label-optional">vanity — also $15/mo</span></label>
                    <div className="ob-searchbar">
                      <input className="ob-input" placeholder='e.g. "PIZZA"' value={vanityWord}
                        onChange={(e) => setVanityWord(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !numbersLoading && vanityToDigits(vanityWord) && searchNumbers("", { tab: "tollfree", vanity: vanityWord })} />
                      <button className="ob-btn-ghost" disabled={numbersLoading || !vanityToDigits(vanityWord)}
                        onClick={() => searchNumbers("", { tab: "tollfree", vanity: vanityWord })}>
                        {numbersLoading ? "Searching…" : "Find my word"}
                      </button>
                    </div>
                    {vanityWord && vanityToDigits(vanityWord) && (
                      <div className="ob-field-hint">
                        On a phone keypad, <b>{vanityWord.toUpperCase()}</b> is <b>{vanityToDigits(vanityWord)}</b> — we&apos;ll look for toll-free numbers ending in it.
                      </div>
                    )}
                  </>
                )}

                {numbersLoading && <div className="ob-field-hint">Finding available numbers… this can take up to 30 seconds.</div>}
                {numbersError && <div className="ob-field-hint">{numbersError}</div>}
                {!numbersLoading && numbers.length > 0 && (
                  <>
                    <div className="ob-num-grid">
                      {numbers.map((n) => {
                        const kind: NumberKind = n.kind || (numbersTab === "tollfree" ? "tollfree" : "local");
                        const pick = () => updateForm({ selectedNumber: n.number, numberKind: kind });
                        return (
                          <div key={n.number} className={`ob-num${form.selectedNumber === n.number ? " selected" : ""}`} tabIndex={0}
                            onClick={pick} onKeyDown={(e) => e.key === "Enter" && pick()}>
                            <div>
                              <div className="ob-num-n">{n.number}</div>
                              {n.location && <div className="ob-num-loc">{n.location}</div>}
                              <div className="ob-caps">
                                {n.inStock && <span className="ob-cap ob-cap-stock">Ready now</span>}
                                {kind !== "local" && <span className="ob-cap ob-cap-stock">$15/mo</span>}
                                {n.voice && <span className="ob-cap">Voice</span>}
                                {n.sms && <span className="ob-cap">SMS</span>}
                              </div>
                            </div>
                            <div className="ob-num-tick"><IconTick /></div>
                          </div>
                        );
                      })}
                    </div>
                    {form.selectedNumber && (
                      <div className="ob-field-hint" style={{ marginTop: 12 }}>
                        Selected: <b>{form.selectedNumber}</b>
                        {form.numberKind === "tollfree" && <> — toll-free, $15.00/month</>}
                        {form.numberKind === "vanity" && <> — toll-free vanity, $15.00/month</>}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Port existing */}
            {form.numberChoice === "port" && (
              <>
                {portability === "checking" && (
                  <div className="ob-field-hint" style={{ marginBottom: 14 }}>Checking whether this number can be transferred…</div>
                )}
                {portability === "portable" && (
                  <div className="ob-port-check">
                    <div className="ob-port-check-ok"><IconTick /></div>
                    <div><b>{form.porting.numbers} can be transferred</b> <span>· typically 3–5 business days</span></div>
                  </div>
                )}
              <div className="ob-porting-details">
                <div className="ob-step-eyebrow" style={{ marginBottom: 14 }}>Details from your current carrier</div>
                <div className="ob-field-row">
                  <div><label className="ob-label">Number to bring over</label><input className="ob-input" placeholder="(555) 000-0000" value={form.porting.numbers} onChange={(e) => updateForm({ porting: { ...form.porting, numbers: e.target.value } })} /></div>
                  <div><label className="ob-label">Current carrier</label><input className="ob-input" placeholder="AT&T, Spectrum…" value={form.porting.carrier} onChange={(e) => updateForm({ porting: { ...form.porting, carrier: e.target.value } })} /></div>
                </div>
                <div className="ob-field-row">
                  <div><label className="ob-label">Account number</label><input className="ob-input" placeholder="Account #" value={form.porting.accountNumber} onChange={(e) => updateForm({ porting: { ...form.porting, accountNumber: e.target.value } })} /></div>
                  <div><label className="ob-label">Porting PIN<span className="ob-label-optional">if any</span></label><input className="ob-input" placeholder="PIN" value={form.porting.portPin} onChange={(e) => updateForm({ porting: { ...form.porting, portPin: e.target.value } })} /></div>
                </div>
                <div className="ob-field"><label className="ob-label">Name on account</label><input className="ob-input" placeholder="As it appears on your phone bill" value={form.porting.nameOnAccount} onChange={(e) => updateForm({ porting: { ...form.porting, nameOnAccount: e.target.value } })} /></div>
                <div className="ob-field"><label className="ob-label">Street address on the bill</label><input className="ob-input" placeholder="123 Main St, Suite 2" value={form.porting.serviceAddress} onChange={(e) => updateForm({ porting: { ...form.porting, serviceAddress: e.target.value } })} /></div>
                <div className="ob-field-row" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
                  <div><label className="ob-label">City</label><input className="ob-input" placeholder="City" value={form.porting.serviceCity} onChange={(e) => updateForm({ porting: { ...form.porting, serviceCity: e.target.value } })} /></div>
                  <div><label className="ob-label">State</label><input className="ob-input" placeholder="NY" maxLength={2} value={form.porting.serviceState} onChange={(e) => updateForm({ porting: { ...form.porting, serviceState: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") } })} /></div>
                  <div><label className="ob-label">ZIP</label><input className="ob-input" placeholder="10952" inputMode="numeric" maxLength={5} value={form.porting.serviceZip} onChange={(e) => updateForm({ porting: { ...form.porting, serviceZip: e.target.value.replace(/\D/g, "") } })} /></div>
                </div>
                <label className="ob-field" style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
                  <input type="checkbox" checked={form.porting.isMobile} onChange={(e) => updateForm({ porting: { ...form.porting, isMobile: e.target.checked } })} style={{ width: 16, height: 16, accentColor: "#2f6bff", cursor: "pointer" }} />
                  <span className="ob-label" style={{ marginBottom: 0 }}>This is a cell phone (wireless) number</span>
                </label>
                {form.porting.isMobile && (
                  <div className="ob-field-hint" style={{ marginTop: -6, marginBottom: 14 }}>Cell transfers need the transfer PIN from your carrier — dial 611 or check their app if you don&apos;t have it.</div>
                )}
                <div className="ob-uploads">
                  <label className={`ob-upl${form.porting.loaFileName ? " done" : ""}`}>
                    <input type="file" accept="application/pdf,image/*" style={{ display: "none" }} disabled={uploading.loa}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPortDoc("loa", f); }} />
                    <div className="ob-upl-ic">{uploading.loa ? <div className="ob-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /> : form.porting.loaFileName ? <IconTick size={20} /> : <IconUpload />}</div>
                    <b>{form.porting.loaFileName ? "Authorization added" : "Signed authorization"}</b>
                    <span>{uploading.loa ? "Uploading…" : form.porting.loaFileName || "PDF or photo"}</span>
                  </label>
                  <label className={`ob-upl${form.porting.billFileName ? " done" : ""}`}>
                    <input type="file" accept="application/pdf,image/*" style={{ display: "none" }} disabled={uploading.bill}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPortDoc("bill", f); }} />
                    <div className="ob-upl-ic">{uploading.bill ? <div className="ob-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /> : form.porting.billFileName ? <IconTick size={20} /> : <IconUpload />}</div>
                    <b>{form.porting.billFileName ? "Bill added" : "Recent phone bill"}</b>
                    <span>{uploading.bill ? "Uploading…" : form.porting.billFileName || "PDF or photo"}</span>
                  </label>
                </div>
                <div className="ob-field-hint" style={{ marginTop: 12 }}>Your number keeps working until the transfer completes — typically 3–5 business days.</div>
              </div>
              </>
            )}
          </div>
        )}

        {/* Step 3: Extensions */}
        {step === 3 && (
          <div>
            <table className="ob-ext-table">
              <thead><tr><th style={{ width: 52, textAlign: "center" }}>Owner</th><th>Name</th><th>Ext #</th><th>Email <span className="ob-label-optional">optional</span></th><th /></tr></thead>
              <tbody>
                {form.extensions.map((ext, i) => (
                  <Fragment key={i}>
                    {/* data-label + the ob-ext-*-td classes exist for phones:
                        below 640px the CSS stacks this table into cards and
                        paints each field's label from data-label. */}
                    <tr className="ob-ext-row">
                      <td className="ob-ext-owner-td" style={{ textAlign: "center" }}>
                        <input
                          type="radio"
                          name="ob-owner-ext"
                          checked={ext.isOwner}
                          onChange={() => setOwnerExt(i)}
                          title="This person owns the account"
                          style={{ width: 16, height: 16, accentColor: "#2f6bff", cursor: "pointer" }}
                        />
                      </td>
                      <td data-label="Name"><input className="ob-input" placeholder="Jane Smith" value={ext.displayName} onChange={(e) => updateExt(i, { displayName: e.target.value })} /></td>
                      {/* Promote on blur, not on change: rewriting mid-typing
                          would turn "1" into "101" before they type the 0. */}
                      <td data-label="Ext #"><input className="ob-input" placeholder="101" value={ext.extNumber}
                        onChange={(e) => updateExt(i, { extNumber: e.target.value.replace(/\D/g, "") })}
                        onBlur={() => { const p = promoteExtNumber(ext.extNumber); if (p !== ext.extNumber) updateExt(i, { extNumber: p }); }}
                        style={{ textAlign: "center" }} /></td>
                      <td data-label="Email"><input className="ob-input" type="email" placeholder="jane@acme.com" value={ext.email} onChange={(e) => updateExt(i, { email: e.target.value })} /></td>
                      <td className="ob-ext-remove-td">{form.extensions.length > 1 && (<button className="ob-ext-remove" onClick={() => removeExt(i)} title="Remove">×</button>)}</td>
                    </tr>
                    <tr className="ob-ext-cell-row">
                      <td colSpan={5}>
                        <div className="ob-ext-cell">
                          <select
                            className="ob-input ob-ext-cell-select"
                            value={ext.cellMode}
                            onChange={(e) => updateExt(i, { cellMode: e.target.value as CellMode, cellNumber: e.target.value ? ext.cellNumber : "" })}
                          >
                            <option value="">Rings their desk phone &amp; app</option>
                            <option value="also">Also rings their cell phone</option>
                            <option value="only">Goes straight to their cell phone</option>
                          </select>
                          {ext.cellMode && (
                            <input
                              className="ob-input ob-ext-cell-input"
                              placeholder="Cell number — (555) 000-0000"
                              value={ext.cellNumber}
                              onChange={(e) => updateExt(i, { cellNumber: e.target.value })}
                            />
                          )}
                        </div>
                        {ext.cellMode && (
                          <div className="ob-field-hint" style={{ marginTop: 6 }}>
                            {ext.cellMode === "also"
                              ? "Calls to this extension will ring the desk phone, the app, and this cell number at the same time."
                              : "Calls to this extension will go straight to this cell number."}
                          </div>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
            <button className="ob-ext-add" onClick={addExt}>+ Add another extension</button>
            <div className="ob-field-hint" style={{ marginTop: 8 }}>
              The <b>owner</b> is the person in charge of the account — they get admin access to manage the
              phone system, billing, and everyone&apos;s settings. It starts as the first person; tap a
              different row&apos;s circle to change it.
            </div>
            <div className="ob-callout">
              <IconCheck />
              <span>These are created on your phone system <b className="ob-auto">automatically</b> the moment you launch — no files to upload, no waiting.</span>
            </div>
          </div>
        )}

        {/* Step 4: Add-ons */}
        {step === 4 && (
          <div>
            <div className={`ob-toggle-row${form.smsEnabled ? " on" : ""}`} onClick={() => updateForm({ smsEnabled: !form.smsEnabled })} style={{ cursor: "pointer" }}>
              <div className="ob-toggle-info">
                <div className="ob-toggle-title">Business SMS messaging</div>
                <div className="ob-toggle-desc">Send &amp; receive texts from your business number, right from Connect.</div>
              </div>
              <label className="ob-toggle-switch" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={form.smsEnabled} onChange={(e) => updateForm({ smsEnabled: e.target.checked })} />
                <span className="ob-toggle-track" />
              </label>
            </div>
            <div className="ob-field-hint" style={{ marginTop: 13 }}>Turn it on now or later from your account — either way it's ready on day one.</div>
          </div>
        )}

        {/* Step 5: Review */}
        {step === 5 && (
          <div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Company</div>
              <div className="ob-review-row"><span className="ob-review-key">Company</span><span className="ob-review-val">{form.companyName}</span></div>
              <div className="ob-review-row"><span className="ob-review-key">Contact</span><span className="ob-review-val">{form.firstName} {form.lastName}</span></div>
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Contact details</div>
              <div className="ob-review-row"><span className="ob-review-key">Phone</span><span className="ob-review-val">{form.mainPhone}</span></div>
              <div className="ob-review-row"><span className="ob-review-key">Address</span><span className="ob-review-val">{[form.address, form.addressCity, [form.addressState, form.addressZip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</span></div>
              <div className="ob-review-row"><span className="ob-review-key">Email</span><span className="ob-review-val">{form.mainEmail}</span></div>
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Your number</div>
              <div className="ob-review-row">
                <span className="ob-review-key">
                  {form.numberChoice === "port"
                    ? "Porting in"
                    : form.numberKind === "vanity"
                      ? "Toll-free vanity number"
                      : form.numberKind === "tollfree"
                        ? "Toll-free number"
                        : "New number"}
                </span>
                <span className="ob-review-val">
                  {form.numberChoice === "port" ? (form.porting.numbers || "—") : (form.selectedNumber || "—")}
                  {form.numberChoice !== "port" && (form.numberKind === "tollfree" || form.numberKind === "vanity") && (
                    <span style={{ opacity: 0.75 }}> · $15.00/mo</span>
                  )}
                </span>
              </div>
              <div className="ob-review-row"><span className="ob-review-key">Server</span><span className="ob-review-val">New York 1{form.smsEnabled ? " · SMS on" : ""}</span></div>
              {form.numberChoice === "port" && (
                <div className="ob-field-hint" style={{ marginTop: 8 }}>
                  While your number transfers — typically <b>3–5 business days</b> — you&apos;ll be live on a
                  temporary number right away, so calls work from day one. Your current number keeps working
                  until the transfer completes.
                </div>
              )}
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Extensions ({form.extensions.filter((e) => e.extNumber).length})</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {form.extensions.filter((e) => e.extNumber).map((e, i) => (
                  <div key={i} className="ob-review-ext-chip">
                    <span className="ob-review-ext-num">{e.extNumber}</span>
                    {e.displayName}
                    {e.isOwner && <span className="ob-review-ext-cell" style={{ fontWeight: 700 }}>Owner</span>}
                    {e.cellMode && <span className="ob-review-ext-cell">{e.cellMode === "only" ? "→ cell" : "+ cell"}</span>}
                  </div>
                ))}
              </div>
              {(() => {
                const filled = form.extensions.filter((e) => e.extNumber.trim());
                const missing = filled.filter((e) => !e.email.trim());
                if (!filled.length || !missing.length) return null;
                return (
                  <div className="ob-warn">
                    {missing.length === filled.length
                      ? "No email addresses were entered, so nobody on your team will receive their login details. Go back to \u201CYour team\u201D and add an email for each person who needs access."
                      : `Extension${missing.length > 1 ? "s" : ""} ${missing.map((e) => e.extNumber).join(", ")} ${missing.length > 1 ? "have" : "has"} no email — ${missing.length > 1 ? "those people" : "that person"} won\u2019t receive login details.`}
                  </div>
                );
              })()}
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">Add-ons</div>
              <div className="ob-review-row"><span className="ob-review-key">SMS messaging</span><span className={`ob-review-val${form.smsEnabled ? " ob-auto" : ""}`}>{form.smsEnabled ? "Enabled" : "Not added"}</span></div>
            </div>
            <div className="ob-review-section">
              <div className="ob-review-section-title">What you&apos;ll pay</div>
              {quote ? (
                <div className="ob-quote">
                  {quote.lines.map((l) => (
                    <div key={l.key} className="ob-quote-row">
                      <span className="ob-quote-label">
                        {l.label}
                        {l.note && <span className="ob-quote-note">{l.note}</span>}
                      </span>
                      {l.quantity > 1 && <span className="ob-quote-qty">{l.quantity} × {money(l.unitCents)}</span>}
                      <span className="ob-quote-amt">{money(l.totalCents)}</span>
                    </div>
                  ))}
                  <div className="ob-quote-row ob-quote-total">
                    <span className="ob-quote-label">
                      <b>Monthly total</b>
                      <span className="ob-quote-note">Charged when you add your card, then every month. Tax included.</span>
                    </span>
                    <span className="ob-quote-amt">{money(quote.monthlyTotalCents)}</span>
                  </div>
                </div>
              ) : quoteFailed ? (
                <div className="ob-field-hint">
                  We couldn&apos;t load your price just now — the payment step will show the exact amount before
                  your card is charged.
                </div>
              ) : (
                <div className="ob-field-hint">Working out your monthly price…</div>
              )}
            </div>
            <div className="ob-callout">
              <span>On launch, Connect builds your tenant, creates every extension from your list, {form.numberChoice === "port" ? "ports" : "buys & wires"} your number, and sets your routing — <b className="ob-auto">all automatically</b>.</span>
            </div>
            {submitError && <div className="ob-error">{submitError}</div>}
          </div>
        )}


        {step === 6 && (
          <div className="ob-pay">
            {checkoutError ? (
              <>
                <div className="ob-error">{checkoutError}</div>
                <button className="ob-btn-next" onClick={() => void startCheckout()}>
                  Try again
                </button>
              </>
            ) : (
              <div className="ob-pay-loading">
                Preparing your secure checkout…
                <p className="ob-pay-handoff">
                  You&apos;ll pay on our standard checkout page, and your card stays on file — that&apos;s how the
                  monthly bill is paid. Card details go straight to the payment provider; they never touch our
                  servers.
                </p>
                {/* The auto-handoff can be left stranded (back-button from the
                    pay page restores this screen from the browser cache with
                    nothing running) — a visible button means the customer is
                    never stuck watching a spinner. */}
                <button
                  className="ob-btn-next"
                  style={{ marginTop: 16 }}
                  onClick={() => { checkoutFired.current = false; void startCheckout(); }}
                >
                  Continue to payment <IconArrowRight />
                </button>
                <p className="ob-field-hint" style={{ marginTop: 10 }}>
                  Not moving after a few seconds? Tap the button.
                </p>
              </div>
            )}
          </div>
        )}

        {stepError && <div className="ob-error">{stepError}</div>}

        {/* Navigation */}
        <div className="ob-actions">
          {step > 0 ? (<button className="ob-btn-back" onClick={goBack}><IconArrowLeft /> Back</button>) : <div />}
          {step < STEPS.length - 2 ? (
            <button className="ob-btn-next" onClick={goNext}>Continue <IconArrowRight /></button>
          ) : step === STEPS.length - 2 ? (
            <button className="ob-btn-next ob-btn-submit" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Saving…" : "Continue to payment"}{!submitting && <IconArrowRight />}
            </button>
          ) : (
            /* The payment step hands off to the real checkout page on its
               own, so the footer carries no button. */
            <div />
          )}
        </div>
      </div>
    </>
  );
}
