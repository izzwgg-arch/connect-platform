"use client";

/**
 * Card gateway test.
 *
 * This page does NOT contain a card form, deliberately. `/pay/invoice/[token]`
 * already exists and is the screen every customer meets when they pay an
 * invoice — signed link, invoice summary, card fields, receipt. Building a
 * second card form here meant the thing under test was a page nobody uses.
 *
 * So all this does is create a real $1 invoice and send you to the real
 * payment screen. A pass proves the page customers actually pay on works,
 * which is the claim worth having.
 */

import { useState } from "react";
import { apiPost } from "../../../../services/apiClient";

interface Started {
  invoiceNumber: string;
  amountCents: number;
  payPath: string;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function CardTestPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<Started>("/billing/card-test/start", {});
      // Straight to the customer screen. Same tab, because the whole point is
      // to walk the path a customer walks.
      window.location.href = r.payPath;
    } catch (e: any) {
      setError(e?.payload?.message || e?.message || "Couldn't create the test invoice.");
      setBusy(false);
    }
  }

  return (
    <div className="ct-wrap">
      <CardTestStyles />
      <div className="ct-eyebrow">Billing</div>
      <h1>Card gateway test</h1>
      <p className="ct-sub">
        Creates a real <b>{money(100)}</b> invoice and opens the same payment screen your customers use. Pay it with
        a real card to prove the processor is working end to end.
      </p>

      <div className="ct-card">
        <div className="ct-amount">
          <span>Amount</span>
          <b>{money(100)}</b>
        </div>

        <ul className="ct-list">
          <li>
            <b>It&apos;s the real screen.</b> You&apos;ll land on the same invoice payment page a customer gets
            emailed &mdash; not a copy of it.
          </li>
          <li>
            <b>It&apos;s a real charge.</b> One dollar actually moves. The invoice is tagged as a card test, so you
            can find it in billing and refund it.
          </li>
          <li>
            <b>The card isn&apos;t saved.</b> This proves the processor takes it; nobody is signing up.
          </li>
        </ul>

        {error && <div className="ct-err">{error}</div>}

        <button className="ct-btn primary" onClick={start} disabled={busy}>
          {busy ? "Creating invoice…" : `Create a ${money(100)} invoice and pay it`}
        </button>
      </div>

      <div className="ct-next">
        <h2>Seeing what happens after a customer pays</h2>
        <p>
          Signing up runs a different flow: a screen that names each stage of the build as it happens, then a short
          walkthrough for deciding what callers hear. You can open that walkthrough directly.
        </p>
        <a className="ct-btn" href="/pbx/ivr-studio?firstrun=1">
          Open first-time setup →
        </a>
        <p className="ct-warn">
          It&apos;s the real thing, on your own account. Clicking through is safe &mdash; nothing is written until the
          last screen and every screen can be skipped &mdash; but pressing <b>Turn it on</b> at the end will genuinely
          create a menu here.
        </p>
      </div>
    </div>
  );
}

function CardTestStyles() {
  return (
    <style jsx global>{`
      .ct-wrap{--pnl:#fff;--pnl2:#f6f9fc;--ln:rgba(19,32,48,.13);--tx:#132030;--dim:#5d6f84;--faint:#8496a8;
        --ac:#1f74d0;--bad:#c9414c;
        max-width:600px;margin:0 auto;padding:14px 4px 60px;color:var(--tx);
        font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      :root[data-theme="dark"] .ct-wrap{--pnl:#16212e;--pnl2:#1c2937;--ln:#2a3a4c;--tx:#e4ecf4;--dim:#8ba0b6;
        --faint:#64798f;--ac:#3ba0f2;--bad:#e2606a}
      .ct-wrap *{box-sizing:border-box}
      .ct-eyebrow{font-size:11px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
      .ct-wrap h1{font-size:25px;font-weight:720;margin:8px 0 0;letter-spacing:-.02em}
      .ct-sub{color:var(--dim);font-size:14.5px;line-height:1.6;margin:10px 0 22px;max-width:58ch}
      .ct-card{background:var(--pnl);border:1px solid var(--ln);border-radius:16px;padding:20px}
      .ct-amount{display:flex;align-items:baseline;justify-content:space-between;padding-bottom:14px;
        margin-bottom:16px;border-bottom:1px solid var(--ln)}
      .ct-amount span{font-size:13px;color:var(--dim)}
      .ct-amount b{font-size:28px;font-weight:730;letter-spacing:-.02em}
      .ct-list{margin:0 0 18px;padding-left:18px;display:flex;flex-direction:column;gap:9px;
        font-size:13.5px;color:var(--dim);line-height:1.6}
      .ct-list b{color:var(--tx)}
      .ct-err{padding:11px 14px;border-radius:11px;font-size:13.5px;line-height:1.55;margin-bottom:14px;
        color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent);
        border:1px solid color-mix(in srgb,var(--bad) 34%,transparent)}
      .ct-btn{display:inline-block;font:inherit;font-size:14.5px;font-weight:650;padding:12px 22px;border-radius:11px;
        cursor:pointer;text-decoration:none;border:1px solid var(--ln);background:var(--pnl);color:var(--tx)}
      .ct-btn.primary{background:var(--ac);border-color:var(--ac);color:#fff}
      .ct-btn.primary:hover{filter:brightness(1.07)}
      .ct-btn:disabled{opacity:.55;cursor:not-allowed}
      .ct-next{margin-top:26px;padding-top:22px;border-top:1px solid var(--ln)}
      .ct-next h2{font-size:17px;font-weight:690;margin:0 0 6px}
      .ct-next p{font-size:13.5px;color:var(--dim);line-height:1.65;margin:0 0 16px;max-width:58ch}
      .ct-warn{margin-top:14px;font-size:12px;color:var(--faint);line-height:1.6}
    `}</style>
  );
}
