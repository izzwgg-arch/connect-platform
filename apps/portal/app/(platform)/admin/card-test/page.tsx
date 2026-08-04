"use client";

/**
 * Card gateway test — a real $1 charge, and then the rest of the signup flow.
 *
 * The signup wizard cannot be used for this. Its amount comes from the same
 * server-side quote the customer agreed to, on purpose, so the figure shown and
 * the figure charged can never drift apart — which makes the smallest possible
 * basket $33. Fine for customers, wrong for "does the processor take money".
 *
 * This runs the SAME gateway call with a server-side constant of $1. Nothing is
 * stubbed: a one-time card token, cc:save, cc:sale, a real transaction against a
 * real invoice. If it goes through, the wizard's payment step works, because it
 * is the same code underneath.
 *
 * On success it carries straight on to what a customer sees after paying — the
 * build-progress screen, then the first-time setup walkthrough — so the whole
 * post-payment experience can be reviewed in one sitting.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CardknoxIFieldsForm } from "../../../../components/billing/CardknoxIFieldsForm";
import { apiGet, apiPost } from "../../../../services/apiClient";

interface Config {
  amountCents: number;
  ifieldsKey: string | null;
  mode: string;
  liveChargesEnabled: boolean;
}

interface Result {
  amountCents: number;
  invoiceNumber: string;
  processorRef: string | null;
  last4: string | null;
  cardBrand: string | null;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function CardTestPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  /** Stable for the life of the page, so a double-submit is one charge. */
  const opId = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `ct-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const c = await apiGet<Config>("/billing/card-test/config");
        if (!dead) setConfig(c);
      } catch (e: any) {
        if (!dead) setLoadError(e?.payload?.message || e?.message || "Couldn't load the payment settings.");
      }
    })();
    return () => { dead = true; };
  }, []);

  const pay = useCallback(async (payload: { cardToken: string; billing: any }) => {
    if (busy) return;
    setBusy(true);
    setPayError(null);
    try {
      const r = await apiPost<Result>("/billing/card-test", {
        xSut: payload.cardToken,
        xExp: [payload.billing?.expMonth, payload.billing?.expYear].filter(Boolean).join("") || undefined,
        cardholderName: payload.billing?.cardholderName || undefined,
        billingZip: payload.billing?.billingZip || undefined,
        clientOperationId: opId.current,
      });
      setResult(r);
    } catch (e: any) {
      // A decline is the answer we came for, so show the processor's own
      // wording rather than a generic failure.
      setPayError(e?.payload?.message || e?.message || "The card was not charged.");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // ── After a successful charge ─────────────────────────────────────────────
  if (result) {
    return (
      <div className="ct-wrap">
        <CardTestStyles />
        <div className="ct-ok-mark" aria-hidden>✓</div>
        <h1>Payment went through</h1>
        <p className="ct-sub">
          {money(result.amountCents)} was charged for real through the same gateway the signup wizard uses.
        </p>

        <div className="ct-receipt">
          <Row label="Amount" value={money(result.amountCents)} />
          <Row label="Card" value={[result.cardBrand, result.last4 ? `•••• ${result.last4}` : null].filter(Boolean).join(" ") || "—"} />
          <Row label="Processor reference" value={result.processorRef || "—"} mono />
          <Row label="Invoice" value={result.invoiceNumber} mono />
        </div>

        <p className="ct-note">
          The invoice is real and shows in billing, marked as a card test — so you can find it and refund it.
          The card was <b>not</b> saved: this proves the processor takes it, it isn&apos;t someone signing up.
        </p>

        <div className="ct-next">
          <h2>What a customer sees next</h2>
          <p>
            After paying, a customer gets a screen that names each stage of their build as it happens, and then a
            short walkthrough for deciding what callers hear. Both are below.
          </p>
          <a className="ct-btn primary" href="/pbx/ivr-studio?firstrun=1">
            Continue to first-time setup →
          </a>
          <p className="ct-warn">
            Heads up: that walkthrough is the real thing, on your own account. Clicking through it is safe — nothing
            is written until the last screen, and every screen can be skipped — but pressing <b>Turn it on</b> at the
            end will genuinely create a menu here.
          </p>
        </div>
      </div>
    );
  }

  // ── Before ────────────────────────────────────────────────────────────────
  return (
    <div className="ct-wrap">
      <CardTestStyles />
      <div className="ct-eyebrow">Billing</div>
      <h1>Card gateway test</h1>
      <p className="ct-sub">
        Charges <b>{money(config?.amountCents ?? 100)}</b> to a real card, through the same processor call the signup
        wizard makes. This is the quickest honest answer to &ldquo;does payment actually work&rdquo;.
      </p>

      {loadError && <div className="ct-err">{loadError}</div>}

      {config && !config.liveChargesEnabled && (
        <div className="ct-err">
          Live card charges are switched off on this server, so there is nothing to test. Nothing you enter here
          would reach the processor.
        </div>
      )}

      {config && config.liveChargesEnabled && !config.ifieldsKey && (
        <div className="ct-err">
          No card-processing key is configured, so the card fields can&apos;t load.
        </div>
      )}

      {config?.ifieldsKey && config.liveChargesEnabled && (
        <div className="ct-card">
          <div className="ct-amount">
            <span>Amount</span>
            <b>{money(config.amountCents)}</b>
          </div>
          {config.mode !== "prod" && (
            <div className="ct-mode">
              Processor is in <b>{config.mode}</b> mode — no real money will move.
            </div>
          )}

          {payError && <div className="ct-err">{payError}</div>}

          <CardknoxIFieldsForm
            ifieldsKey={config.ifieldsKey}
            variant="customer"
            fieldTheme="light"
            showBillingAddress={false}
            showEmail={false}
            showSaveOptions={false}
            submitLabel={`Charge ${money(config.amountCents)}`}
            busyLabel="Charging…"
            disabled={busy}
            onSubmitCardToken={pay}
          />

          <p className="ct-note">
            Card details go straight to the payment provider and never touch our servers. The card is not saved.
          </p>
        </div>
      )}

      {!config && !loadError && <p className="ct-sub">Loading…</p>}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="ct-row">
      <span>{label}</span>
      <b className={mono ? "mono" : undefined}>{value}</b>
    </div>
  );
}

function CardTestStyles() {
  return (
    <style jsx global>{`
      .ct-wrap{--pnl:#fff;--pnl2:#f6f9fc;--ln:rgba(19,32,48,.13);--tx:#132030;--dim:#5d6f84;--faint:#8496a8;
        --ac:#1f74d0;--ok:#1a9d5c;--bad:#c9414c;
        max-width:600px;margin:0 auto;padding:14px 4px 60px;color:var(--tx);
        font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      :root[data-theme="dark"] .ct-wrap{--pnl:#16212e;--pnl2:#1c2937;--ln:#2a3a4c;--tx:#e4ecf4;--dim:#8ba0b6;
        --faint:#64798f;--ac:#3ba0f2;--ok:#3ec37e;--bad:#e2606a}
      .ct-wrap *{box-sizing:border-box}
      .ct-eyebrow{font-size:11px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
      .ct-wrap h1{font-size:25px;font-weight:720;margin:8px 0 0;letter-spacing:-.02em}
      .ct-sub{color:var(--dim);font-size:14.5px;line-height:1.6;margin:10px 0 22px;max-width:56ch}
      .ct-card{background:var(--pnl);border:1px solid var(--ln);border-radius:16px;padding:20px}
      .ct-amount{display:flex;align-items:baseline;justify-content:space-between;padding-bottom:14px;
        margin-bottom:16px;border-bottom:1px solid var(--ln)}
      .ct-amount span{font-size:13px;color:var(--dim)}
      .ct-amount b{font-size:28px;font-weight:730;letter-spacing:-.02em}
      .ct-mode{font-size:12.5px;color:var(--dim);background:var(--pnl2);border:1px solid var(--ln);
        border-radius:10px;padding:9px 12px;margin-bottom:14px}
      .ct-err{padding:11px 14px;border-radius:11px;font-size:13.5px;line-height:1.55;margin-bottom:14px;
        color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent);
        border:1px solid color-mix(in srgb,var(--bad) 34%,transparent)}
      .ct-note{font-size:12px;color:var(--faint);line-height:1.6;margin-top:14px}
      .ct-ok-mark{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;font-size:24px;
        font-weight:800;background:var(--ok);color:#fff;margin-bottom:16px}
      .ct-receipt{background:var(--pnl);border:1px solid var(--ln);border-radius:14px;padding:6px 16px}
      .ct-row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;font-size:14px}
      .ct-row + .ct-row{border-top:1px solid var(--ln)}
      .ct-row span{color:var(--dim)}
      .ct-row b{font-weight:640;text-align:right;word-break:break-all}
      .ct-row b.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;font-weight:550}
      .ct-next{margin-top:26px;padding-top:22px;border-top:1px solid var(--ln)}
      .ct-next h2{font-size:17px;font-weight:690;margin:0 0 6px}
      .ct-next p{font-size:13.5px;color:var(--dim);line-height:1.65;margin:0 0 16px;max-width:58ch}
      .ct-btn{display:inline-block;font-size:14.5px;font-weight:650;padding:12px 22px;border-radius:11px;
        text-decoration:none;border:1px solid var(--ln);background:var(--pnl);color:var(--tx)}
      .ct-btn.primary{background:var(--ac);border-color:var(--ac);color:#fff}
      .ct-btn.primary:hover{filter:brightness(1.07)}
      .ct-warn{margin-top:14px;font-size:12px;color:var(--faint);line-height:1.6}
    `}</style>
  );
}
