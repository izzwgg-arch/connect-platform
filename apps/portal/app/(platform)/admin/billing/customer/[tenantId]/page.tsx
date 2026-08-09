"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiGet, apiPut } from "../../../../../../services/apiClient";
import { BillingNav } from "../../_new/ui";
import "../customerBilling.css";

/* One customer's billing, on one screen.
   Replaces: pricing, plan assignment, quantity overrides, flat rate, toll-free /
   virtual extension pricing, billing day, timezone, payment terms, schedule
   override, collections rules, taxes & fees, billing email and cards — which
   today live across eleven places, seven of them only inside an untyped
   metadata blob with no UI at all. */

type Money = number; // cents

type TenantBillingSettings = {
  tenantId: string;
  billingPlanId: string | null;
  extensionPriceCents: Money;
  additionalPhoneNumberPriceCents: Money;
  smsPriceCents: Money;
  pbxDidPriceCents: Money;
  firstPhoneNumberFree: boolean;
  smsBillingEnabled: boolean;
  taxEnabled: boolean;
  taxProfileId: string | null;
  autoBillingEnabled: boolean;
  billingDayOfMonth: number;
  paymentTermsDays: number;
  defaultPaymentMethodId: string | null;
  billingEmail: string | null;
  creditsCents: Money;
  discountPercent: string | number;
  metadata: Record<string, any> | null;
};

type PaymentMethod = {
  id: string;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  active?: boolean | null;
};

type PreviewLine = { description: string; amountCents: Money; quantity?: number };
type Preview = {
  lineItems?: PreviewLine[];
  subtotalCents?: Money;
  taxCents?: Money;
  totalCents?: Money;
};

type Plan = { id: string; name: string; active?: boolean };
type TaxProfile = { id: string; name: string };

const TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
];

function centsToInput(c: Money | null | undefined): string {
  const n = Number(c ?? 0);
  return (n / 100).toFixed(2);
}
function inputToCents(v: string): Money {
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
function money(c: Money | null | undefined): string {
  const n = Number(c ?? 0);
  return `${n < 0 ? "-" : ""}$${Math.abs(n / 100).toFixed(2)}`;
}
function readMeta(meta: Record<string, any> | null | undefined, key: string): any {
  if (!meta || typeof meta !== "object") return undefined;
  return meta[key];
}
function errText(e: any, fallback: string): string {
  // ⛔ ApiError exposes the server JSON as `.body`, never `.payload`.
  return (
    e?.body?.detail ||
    e?.body?.message ||
    e?.body?.error ||
    e?.message ||
    fallback
  );
}

export default function CustomerBillingPage() {
  const params = useParams();
  const tenantId = String((params as any)?.tenantId || "");

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedAt, setSavedAt] = useState<string>("");

  const [original, setOriginal] = useState<TenantBillingSettings | null>(null);
  const [form, setForm] = useState<TenantBillingSettings | null>(null);
  const [cards, setCards] = useState<PaymentMethod[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [taxProfiles, setTaxProfiles] = useState<TaxProfile[]>([]);
  const [tenantName, setTenantName] = useState("");

  // metadata-backed fields, surfaced as real controls
  const [tollFreeCents, setTollFreeCents] = useState("0.00");
  const [virtualExtCents, setVirtualExtCents] = useState("0.00");
  const [flatRateOn, setFlatRateOn] = useState(false);
  const [flatRateCents, setFlatRateCents] = useState("0.00");
  const [timeZone, setTimeZone] = useState("America/New_York");
  const [e911Cents, setE911Cents] = useState("0.00");
  const [regulatoryCents, setRegulatoryCents] = useState("0.00");
  const [skipNext, setSkipNext] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const [retryCount, setRetryCount] = useState(3);
  const [retryHours, setRetryHours] = useState(12);
  const [collectionsPaused, setCollectionsPaused] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setLoadError("");
    setOriginalExtras(""); // re-snapshot once the metadata fields have landed
    try {
      const s = await apiGet<TenantBillingSettings>(`/admin/billing/tenants/${tenantId}/settings`);
      setOriginal(s);
      setForm(s);

      const meta = s.metadata || {};
      setTollFreeCents(centsToInput(readMeta(meta, "tollFreeDidPriceCents") ?? 0));
      setVirtualExtCents(centsToInput(readMeta(meta, "virtualExtensionPriceCents") ?? 0));
      const flat = readMeta(meta, "billingFlatRate");
      setFlatRateOn(Boolean(flat?.enabled));
      setFlatRateCents(centsToInput(flat?.amountCents ?? 0));
      setTimeZone(String(readMeta(meta, "billingTimeZone") || "America/New_York"));
      const fees = readMeta(meta, "billingTelecomFees") || {};
      setE911Cents(centsToInput(fees?.e911?.amountCents ?? fees?.e911PerNumberCents ?? 0));
      setRegulatoryCents(centsToInput(fees?.regulatory?.amountCents ?? fees?.regulatoryFlatCents ?? 0));
      const override = readMeta(meta, "billingScheduleOverride") || {};
      setSkipNext(Boolean(override?.skipNextPayment));
      setSkipReason(String(override?.skipReason || ""));
      const collections = readMeta(meta, "collections") || {};
      setRetryCount(Number(collections?.maxAttempts ?? 3));
      setRetryHours(Number(collections?.retryDelayHours ?? 12));
      setCollectionsPaused(Boolean(collections?.paused));

      // Everything else is best-effort: the page must still render if one fails.
      apiGet<any>(`/admin/billing/platform/tenants/${tenantId}/payment-methods`)
        .then((r) => setCards(Array.isArray(r) ? r : r?.paymentMethods || r?.methods || []))
        .catch(() => setCards([]));
      apiGet<Preview>(`/admin/billing/platform/tenants/${tenantId}/invoice-preview`)
        .then((r) => setPreview(r))
        .catch(() => setPreview(null));
      apiGet<any>(`/admin/billing/platform/billing-plans`)
        .then((r) => setPlans(Array.isArray(r) ? r : r?.plans || []))
        .catch(() => setPlans([]));
      apiGet<any>(`/admin/billing/tax-profiles`)
        .then((r) => setTaxProfiles(Array.isArray(r) ? r : r?.taxProfiles || r?.profiles || []))
        .catch(() => setTaxProfiles([]));
      apiGet<any>(`/admin/billing/platform/tenants/${tenantId}`)
        .then((r) => setTenantName(String(r?.tenant?.name || r?.name || "")))
        .catch(() => undefined);
    } catch (e: any) {
      setLoadError(errText(e, "Could not load this customer's billing settings."));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = useCallback(<K extends keyof TenantBillingSettings>(key: K, value: TenantBillingSettings[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSavedAt("");
  }, []);

  /** Everything the page can edit, including the settings that live inside the
      untyped metadata blob. They are part of "dirty" — before, only `form` was
      compared, so a metadata edit was invisible to it. */
  const extras = useMemo(
    () => ({
      tollFreeCents, virtualExtCents, flatRateOn, flatRateCents, timeZone,
      e911Cents, regulatoryCents, skipNext, skipReason,
      retryCount, retryHours, collectionsPaused,
    }),
    [tollFreeCents, virtualExtCents, flatRateOn, flatRateCents, timeZone, e911Cents,
     regulatoryCents, skipNext, skipReason, retryCount, retryHours, collectionsPaused],
  );
  const [originalExtras, setOriginalExtras] = useState<string>("");

  // Snapshot the metadata-backed fields once, right after a load settles, so
  // "dirty" has a baseline to compare against.
  useEffect(() => {
    if (!loading && form && originalExtras === "") setOriginalExtras(JSON.stringify(extras));
  }, [loading, form, extras, originalExtras]);

  /** ⛔ This used to end `|| savedAt === ""`, and savedAt starts empty — so a
      page you had just opened and never touched announced "Unsaved changes"
      with the Save button lit. "No changes" was unreachable, which teaches
      people to ignore the bar entirely. */
  const dirty = useMemo(() => {
    if (!form || !original) return false;
    if (JSON.stringify(form) !== JSON.stringify(original)) return true;
    return originalExtras !== "" && JSON.stringify(extras) !== originalExtras;
  }, [form, original, extras, originalExtras]);

  const previewLines = useMemo(() => {
    const all = preview?.lineItems || [];
    return {
      charged: all.filter((li) => Number(li.amountCents || 0) !== 0),
      includedCount: all.filter((li) => Number(li.amountCents || 0) === 0).length,
    };
  }, [preview]);

  const activeCard = useMemo(
    () => cards.find((c) => c.id === form?.defaultPaymentMethodId) || cards.find((c) => c.active) || null,
    [cards, form?.defaultPaymentMethodId],
  );

  const save = useCallback(async () => {
    if (!form || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await apiPut(`/admin/billing/tenants/${tenantId}/settings`, {
        extensionPriceCents: form.extensionPriceCents,
        additionalPhoneNumberPriceCents: form.additionalPhoneNumberPriceCents,
        smsPriceCents: form.smsPriceCents,
        pbxDidPriceCents: form.pbxDidPriceCents,
        firstPhoneNumberFree: form.firstPhoneNumberFree,
        smsBillingEnabled: form.smsBillingEnabled,
        taxEnabled: form.taxEnabled,
        taxProfileId: form.taxProfileId,
        billingDayOfMonth: form.billingDayOfMonth,
        paymentTermsDays: form.paymentTermsDays,
        // Always sent explicitly — this field used to be erased by any save that
        // omitted it. Sending it is now belt and braces on top of the API fix.
        billingEmail: form.billingEmail ? String(form.billingEmail) : null,
        creditsCents: form.creditsCents,
        discountPercent: Number(form.discountPercent) || 0,
        billingPricingMode: "custom",
        tollFreeDidPriceCents: inputToCents(tollFreeCents),
        virtualExtensionPriceCents: inputToCents(virtualExtCents),
        // ⛔ These three were rendered as live controls, marked the page dirty
        // when edited, and were then dropped on the floor — the save reported
        // success and the old values came back on reload. The two fees are what
        // make a customer's month-2 invoice match their sign-up quote.
        billingTimeZone: timeZone,
        // The API validates the whole fee item, not just the amount — a partial
        // object is rejected and takes the entire save down with it. E911 stays
        // on per_phone_number: per_did counts only BILLABLE numbers, which is
        // zero for a one-number tenant on first-number-free.
        billingTelecomFees: {
          e911: {
            enabled: inputToCents(e911Cents) > 0,
            customerVisible: true,
            label: "E911 service fee",
            mode: "amountCents" as const,
            amountCents: inputToCents(e911Cents),
            basis: "per_phone_number" as const,
          },
          regulatory: {
            enabled: inputToCents(regulatoryCents) > 0,
            customerVisible: true,
            label: "Regulatory recovery fee",
            mode: "amountCents" as const,
            amountCents: inputToCents(regulatoryCents),
            basis: "flat_monthly" as const,
          },
        },
        billingFlatRate: flatRateOn
          ? { enabled: true, amountCents: inputToCents(flatRateCents), appliesTo: "extensions" as const }
          : null,
        billingScheduleOverride: skipNext
          ? {
              nextPaymentDate: null,
              skipNextPayment: true,
              skipReason: skipReason || null,
              updatedAt: new Date().toISOString(),
            }
          : null,
      });
      // Retry rules live behind their own endpoint, not the settings PUT.
      await apiPut(`/admin/billing/platform/tenants/${tenantId}/collections-config`, {
        dunningEnabled: !collectionsPaused,
        maxAttempts: Math.max(1, Math.min(10, retryCount)),
        retryDelayHours: Math.max(1, Math.min(336, retryHours)),
      }).catch(() => undefined);

      setSavedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      setOriginal(form);
      setOriginalExtras(JSON.stringify(extras));
      apiGet<Preview>(`/admin/billing/platform/tenants/${tenantId}/invoice-preview`)
        .then((r) => setPreview(r))
        .catch(() => undefined);
    } catch (e: any) {
      setSaveError(errText(e, "Could not save. Nothing was changed."));
    } finally {
      setSaving(false);
    }
  }, [form, saving, tenantId, tollFreeCents, virtualExtCents, flatRateOn, flatRateCents, timeZone,
      e911Cents, regulatoryCents, skipNext, skipReason, collectionsPaused, retryCount, retryHours, extras]);

  if (loading) return <div className="cbill"><p className="cbill-sub">Loading this customer's billing…</p></div>;
  if (loadError) return <div className="cbill"><div className="cbill-banner bad">{loadError}</div></div>;
  if (!form) return null;

  const notCharged = !form.autoBillingEnabled;
  const noCard = !activeCard;

  return (
    <div className="cbill">
      <BillingNav current="customers" />
      <div className="cbill-head">
        <div>
          <Link className="cbill-back" href="/admin/billing/customers">← All customers</Link>
          <h2>{tenantName || "Customer"} — billing</h2>
          <div className="cbill-sub">
            {noCard ? (
              <span className="cbill-pill bad">No card on file</span>
            ) : (
              <span className="cbill-pill ok">
                {activeCard?.brand || "Card"} ····{activeCard?.last4 || "????"}
              </span>
            )}
            <span>
              Charged on the {form.billingDayOfMonth}
              {form.billingDayOfMonth === 1 ? "st" : form.billingDayOfMonth === 2 ? "nd" : form.billingDayOfMonth === 3 ? "rd" : "th"} of each month
            </span>
            <span>·</span>
            <span>{timeZone.replace("America/", "").replace("_", " ")} time</span>
          </div>
        </div>
        {/* This page had no actions at all — no way back, no way to their
            invoices, and no way to add a card, even though "Needs you" shows an
            "Add a card" button that links straight here. */}
        <div className="cbill-toolbar">
          <Link className="cbill-btn" href={`/admin/billing/customer/${tenantId}/timeline`}>Timeline</Link>
          <Link className="cbill-btn" href="/admin/billing/invoice">Invoices</Link>
          <Link className="cbill-btn primary" href={`/admin/billing/methods?tenantId=${tenantId}`}>
            {noCard ? "Add a card" : "Manage cards"}
          </Link>
        </div>
      </div>

      {noCard && (
        <div className="cbill-banner bad">
          <span>
            <strong>This customer cannot be charged.</strong> Every customer needs a card on file —
            add one before their next payment date or the charge will not happen.
          </span>
        </div>
      )}
      {notCharged && !noCard && (
        <div className="cbill-banner warn">
          <span>
            <strong>This customer is not being charged automatically.</strong> They have a card on
            file but automatic charging is switched off, so their invoices are not collected. Turning
            it on will charge them on their next payment date.
          </span>
        </div>
      )}

      <div className="cbill-grid">
        <div className="cbill-col">
          {/* ── What they pay for ─────────────────────────────────────── */}
          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>What they pay for</h3>
              <span className="hint">Prices are exactly what you type — $0.00 means free</span>
            </div>
            <div className="cbill-card-bd">
              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Plan</span>
                  <span className="h">The starting point. Anything you change below overrides it for this customer only.</span>
                </div>
                <div className="cbill-controls">
                  <select
                    className="cbill-select"
                    value={form.billingPlanId || ""}
                    onChange={(e) => set("billingPlanId", e.target.value || null)}
                  >
                    <option value="">No plan</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Extensions</span>
                  <span className="h">Counted automatically each month</span>
                </div>
                <div className="cbill-controls">
                  <input
                    className="cbill-input"
                    value={centsToInput(form.extensionPriceCents)}
                    onChange={(e) => set("extensionPriceCents", inputToCents(e.target.value))}
                    aria-label="Price per extension"
                  />
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Phone numbers</span>
                  <span className="h">Price for each number beyond the first</span>
                </div>
                <div className="cbill-controls">
                  <button
                    type="button"
                    className="cbill-toggle"
                    data-on={form.firstPhoneNumberFree}
                    aria-label="First phone number is free"
                    onClick={() => set("firstPhoneNumberFree", !form.firstPhoneNumberFree)}
                  />
                  <span className="cbill-x">first free</span>
                  <input
                    className="cbill-input"
                    value={centsToInput(form.additionalPhoneNumberPriceCents)}
                    onChange={(e) => set("additionalPhoneNumberPriceCents", inputToCents(e.target.value))}
                    aria-label="Price per additional phone number"
                  />
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Toll-free numbers</span>
                  <span className="h">Price for each toll-free number, every month</span>
                </div>
                <div className="cbill-controls">
                  <input className="cbill-input" value={tollFreeCents} onChange={(e) => { setTollFreeCents(e.target.value); setSavedAt(""); }} aria-label="Toll-free number price" />
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Virtual extensions</span>
                  <span className="h">Extensions with no phone of their own</span>
                </div>
                <div className="cbill-controls">
                  <input className="cbill-input" value={virtualExtCents} onChange={(e) => { setVirtualExtCents(e.target.value); setSavedAt(""); }} aria-label="Virtual extension price" />
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Phone-system numbers</span>
                  <span className="h">Numbers synced from the phone system. $0.00 means included.</span>
                </div>
                <div className="cbill-controls">
                  <input
                    className="cbill-input"
                    value={centsToInput(form.pbxDidPriceCents)}
                    onChange={(e) => set("pbxDidPriceCents", inputToCents(e.target.value))}
                    aria-label="Price per phone-system number"
                  />
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Text messaging</span>
                  <span className="h">Turn on to bill this customer for texting</span>
                </div>
                <div className="cbill-controls">
                  <button
                    type="button"
                    className="cbill-toggle"
                    data-on={form.smsBillingEnabled}
                    aria-label="Bill for text messaging"
                    onClick={() => set("smsBillingEnabled", !form.smsBillingEnabled)}
                  />
                  <input
                    className="cbill-input"
                    value={centsToInput(form.smsPriceCents)}
                    onChange={(e) => set("smsPriceCents", inputToCents(e.target.value))}
                    aria-label="Text messaging price"
                    disabled={!form.smsBillingEnabled}
                  />
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">One flat monthly rate instead</span>
                  <span className="h">Replaces the per-extension charge with a single fixed amount</span>
                </div>
                <div className="cbill-controls">
                  <button
                    type="button"
                    className="cbill-toggle"
                    data-on={flatRateOn}
                    aria-label="Use a flat monthly rate"
                    onClick={() => { setFlatRateOn(!flatRateOn); setSavedAt(""); }}
                  />
                  <input className="cbill-input" value={flatRateCents} onChange={(e) => { setFlatRateCents(e.target.value); setSavedAt(""); }} disabled={!flatRateOn} aria-label="Flat monthly rate" />
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Discount</span>
                  <span className="h">Percentage off the whole invoice, before tax</span>
                </div>
                <div className="cbill-controls">
                  <input
                    className="cbill-input qty"
                    value={String(Math.round((Number(form.discountPercent) || 0) * 100))}
                    onChange={(e) => {
                      const pct = Math.max(0, Math.min(100, Number(e.target.value.replace(/[^0-9]/g, "")) || 0));
                      set("discountPercent", (pct / 100) as any);
                    }}
                    aria-label="Discount percent"
                  />
                  <span className="cbill-x">%</span>
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Account credit</span>
                  <span className="h">Used up automatically on the next invoices</span>
                </div>
                <div className="cbill-controls">
                  <input
                    className="cbill-input"
                    value={centsToInput(form.creditsCents)}
                    onChange={(e) => set("creditsCents", inputToCents(e.target.value))}
                    aria-label="Account credit"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* ── Billing schedule ──────────────────────────────────────── */}
          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>Billing schedule</h3>
              <span className="hint">The card is charged on this date and no other day</span>
            </div>
            <div className="cbill-card-bd">
              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Charge them on the</span>
                  <span className="h">Every month. Short months use the last day.</span>
                </div>
                <div className="cbill-controls">
                  <select
                    className="cbill-select"
                    value={form.billingDayOfMonth}
                    onChange={(e) => set("billingDayOfMonth", Number(e.target.value))}
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <select className="cbill-select" value={timeZone} onChange={(e) => { setTimeZone(e.target.value); setSavedAt(""); }}>
                    {TIME_ZONES.map((tz) => (
                      <option key={tz} value={tz}>{tz.replace("America/", "").replace("_", " ")}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Payment terms</span>
                  <span className="h">Shown on the invoice as the due date</span>
                </div>
                <div className="cbill-controls">
                  <input
                    className="cbill-input qty"
                    value={String(form.paymentTermsDays)}
                    onChange={(e) => set("paymentTermsDays", Math.max(0, Math.min(90, Number(e.target.value.replace(/[^0-9]/g, "")) || 0)))}
                    aria-label="Payment terms in days"
                  />
                  <span className="cbill-x">days</span>
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Skip next month's charge</span>
                  <span className="h">One month only — it turns itself back off afterwards</span>
                </div>
                <div className="cbill-controls">
                  <button
                    type="button"
                    className="cbill-toggle"
                    data-on={skipNext}
                    aria-label="Skip next month's charge"
                    onClick={() => { setSkipNext(!skipNext); setSavedAt(""); }}
                  />
                  <input
                    className="cbill-input text"
                    style={{ width: 180 }}
                    placeholder="Reason (optional)"
                    value={skipReason}
                    onChange={(e) => { setSkipReason(e.target.value); setSavedAt(""); }}
                    disabled={!skipNext}
                    aria-label="Reason for skipping"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* ── Taxes & fees ──────────────────────────────────────────── */}
          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>Taxes &amp; fees</h3>
            </div>
            <div className="cbill-card-bd">
              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Sales tax</span>
                  <span className="h">Off means this customer's price already includes tax</span>
                </div>
                <div className="cbill-controls">
                  <button
                    type="button"
                    className="cbill-toggle"
                    data-on={form.taxEnabled}
                    aria-label="Charge sales tax"
                    onClick={() => set("taxEnabled", !form.taxEnabled)}
                  />
                  <select
                    className="cbill-select"
                    value={form.taxProfileId || ""}
                    onChange={(e) => set("taxProfileId", e.target.value || null)}
                    disabled={!form.taxEnabled}
                  >
                    <option value="">No profile</option>
                    {taxProfiles.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">911 service fee</span>
                  <span className="h">Charged for each phone number, every month</span>
                </div>
                <div className="cbill-controls">
                  <input className="cbill-input" value={e911Cents} onChange={(e) => { setE911Cents(e.target.value); setSavedAt(""); }} aria-label="E911 fee" />
                </div>
              </div>

              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Regulatory fee</span>
                  <span className="h">Flat, once per invoice</span>
                </div>
                <div className="cbill-controls">
                  <input className="cbill-input" value={regulatoryCents} onChange={(e) => { setRegulatoryCents(e.target.value); setSavedAt(""); }} aria-label="Regulatory fee" />
                </div>
              </div>
            </div>
          </section>

          {/* ── Emails ────────────────────────────────────────────────── */}
          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>Who gets the invoice</h3>
              <span className="hint">Separate several addresses with commas</span>
            </div>
            <div className="cbill-card-bd">
              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Billing contact</span>
                  <span className="h">Invoices, reminders and receipts all go here</span>
                </div>
                <div className="cbill-controls">
                  <input
                    className="cbill-input text"
                    value={form.billingEmail || ""}
                    placeholder="nobody@example.com"
                    onChange={(e) => set("billingEmail", e.target.value)}
                    aria-label="Billing email"
                  />
                </div>
              </div>
              {!form.billingEmail && (
                <div className="cbill-row">
                  <div className="cbill-banner warn" style={{ width: "100%" }}>
                    <span>No billing address on file — this customer receives no invoices at all.</span>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ── Right column ────────────────────────────────────────────── */}
        <div className="cbill-col">
          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>Their next invoice</h3>
              {preview ? <span className="cbill-pill info">Preview</span> : null}
            </div>
            <div className="cbill-card-bd" style={{ paddingBottom: 15 }}>
              {!preview && <p className="cbill-sub">Preview unavailable.</p>}
              {preview && (
                <>
                  {/* Four phone numbers at $0.00 above a $30.00 total made the
                      preview look broken. The included ones collapse to a
                      single line; anything actually charged stays itemised. */}
                  {previewLines.charged.map((li, i) => (
                    <div className="cbill-prev-line" key={i}>
                      <span>{li.description}</span>
                      <span>{money(li.amountCents)}</span>
                    </div>
                  ))}
                  {previewLines.includedCount > 0 && (
                    <div className="cbill-prev-line">
                      <span>
                        {previewLines.includedCount} included{" "}
                        {previewLines.includedCount === 1 ? "item" : "items"}
                      </span>
                      <span>{money(0)}</span>
                    </div>
                  )}
                  {typeof preview.taxCents === "number" && preview.taxCents > 0 && (
                    <div className="cbill-prev-line">
                      <span>Sales tax</span>
                      <span>{money(preview.taxCents)}</span>
                    </div>
                  )}
                  <div className="cbill-prev-total">
                    <span>Total</span>
                    <span>{money(preview.totalCents)}</span>
                  </div>
                  <p className="cbill-sub" style={{ marginTop: 10 }}>
                    Recalculated after each save. This is the invoice that will be created for the
                    next cycle.
                  </p>
                </>
              )}
            </div>
          </section>

          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>Card on file</h3>
              <span className="cbill-pill off">Required</span>
            </div>
            <div className="cbill-card-bd" style={{ paddingBottom: 12 }}>
              {cards.length === 0 && (
                <p className="cbill-sub" style={{ padding: "8px 0" }}>
                  No card. This customer cannot be charged.
                </p>
              )}
              {cards.map((c) => (
                <div className="cbill-card-row" key={c.id}>
                  <div>
                    <div>
                      {c.brand || "Card"} ····{c.last4 || "????"}{" "}
                      {c.id === form.defaultPaymentMethodId && <span className="cbill-pill ok">Charging this one</span>}
                    </div>
                    <div className="meta">
                      {c.expMonth && c.expYear ? `Expires ${String(c.expMonth).padStart(2, "0")}/${String(c.expYear).slice(-2)}` : " "}
                      {c.active === false ? " · inactive" : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>If the card is declined</h3>
            </div>
            <div className="cbill-card-bd">
              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Retry</span>
                  <span className="h">Then stop and flag it for you</span>
                </div>
                <div className="cbill-controls">
                  <input className="cbill-input qty" value={String(retryCount)} onChange={(e) => { setRetryCount(Number(e.target.value.replace(/[^0-9]/g, "")) || 1); setSavedAt(""); }} aria-label="Retry attempts" />
                  <span className="cbill-x">times,</span>
                  <input className="cbill-input qty" value={String(retryHours)} onChange={(e) => { setRetryHours(Number(e.target.value.replace(/[^0-9]/g, "")) || 1); setSavedAt(""); }} aria-label="Hours between retries" />
                  <span className="cbill-x">hrs apart</span>
                </div>
              </div>
              <div className="cbill-row">
                <div className="cbill-label">
                  <span className="t">Pause chasing</span>
                  <span className="h">Stops retries and reminder emails while you sort something out</span>
                </div>
                <div className="cbill-controls">
                  <button
                    type="button"
                    className="cbill-toggle"
                    data-on={collectionsPaused}
                    aria-label="Pause collections"
                    onClick={() => { setCollectionsPaused(!collectionsPaused); setSavedAt(""); }}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div className="cbill-savebar">
        <div className="status">
          {saveError ? (
            <span style={{ color: "var(--cb-crit)" }}>{saveError}</span>
          ) : savedAt ? (
            <span style={{ color: "var(--cb-good)" }}>Saved at {savedAt}</span>
          ) : dirty ? (
            "Unsaved changes"
          ) : (
            "No changes"
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="cbill-btn" onClick={() => void load()} disabled={saving}>
            Discard
          </button>
          <button type="button" className="cbill-btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
