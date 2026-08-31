"use client";

/**
 * Scoped onboarding links — "just submit a port" and "just add extensions"
 * (Izzy, 2026-08-30). An admin can send a link that opens ONE short flow
 * instead of the whole sign-up wizard: an existing customer bringing a number
 * over, or adding people to their phone system. The link's purpose is
 * `answers.linkKind`, stamped at creation and read off /validate.
 *
 * ⛔ No payment, no checkout, no purchase — the api refuses checkout / submit /
 * apply-number outright on a scoped link (`wrong_link_kind`). A port lands in
 * the admin Port queue (it writes the same portFiling block); an extension
 * request lands in the submissions list at SUBMITTED.
 *
 * `PortDetailsSection` is the ONE render of the carrier-port fields — the full
 * wizard's port step uses it too, so the two can never drift (the
 * two-publish-paths rule).
 */

import { useState } from "react";
import { ConnectSelect } from "../../../components/ConnectSelect";

export type CellMode = "" | "also" | "only";
export type WizExtension = {
  displayName: string;
  extNumber: string;
  email: string;
  vmPassword: string;
  cellMode: CellMode;
  cellNumber: string;
  isOwner: boolean;
};

export type PortingFields = {
  carrier: string;
  numbers: string;
  accountNumber: string;
  nameOnAccount: string;
  serviceAddress: string;
  serviceCity: string;
  serviceState: string;
  serviceZip: string;
  isMobile: boolean;
  portPin: string;
  loaFileName: string;
  billFileName: string;
  loaSignature: string;
};

function TickIcon({ size = 12 }: { size?: number }) {
  return (<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 8 7 12 13 4" /></svg>);
}
function UploadIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>);
}

/** The one validation both the full wizard's step-2 port branch and the scoped
 *  flow run — page.tsx's validateStep delegates its port half here. */
export function validatePortDetails(p: PortingFields): string | null {
  if (p.numbers.trim().length < 7) return "Enter the number you'd like to bring over.";
  if (p.carrier.trim().length < 2) return "Your current carrier is required.";
  if (p.accountNumber.trim().length < 1) return "Your carrier account number is required.";
  if (p.serviceAddress.trim().length < 3) return "The street address from your carrier bill is required.";
  if (p.serviceCity.trim().length < 2) return "The city from your carrier bill is required.";
  if (!/^[A-Za-z]{2}$/.test(p.serviceState.trim())) return "Enter the 2-letter state (like NY) from your carrier bill.";
  if (!/^\d{5}$/.test(p.serviceZip.trim())) return "Enter the 5-digit ZIP code from your carrier bill.";
  if (p.isMobile && !p.portPin.trim()) return "Cell number transfers need the transfer PIN from your current carrier.";
  if (p.loaSignature.trim().length < 3) return "Sign the transfer authorization by typing your full name.";
  return null;
}

export function PortDetailsSection(props: {
  porting: PortingFields;
  onPatch: (patch: Partial<PortingFields>) => void;
  portability: "idle" | "checking" | "portable" | "unknown";
  uploading: { loa: boolean; bill: boolean };
  onUpload: (kind: "loa" | "bill", file: File) => void;
}) {
  const { porting, onPatch, portability, uploading, onUpload } = props;
  return (
    <>
      {portability === "checking" && (
        <div className="ob-field-hint" style={{ marginBottom: 14 }}>Checking whether this number can be transferred…</div>
      )}
      {portability === "portable" && (
        <div className="ob-port-check">
          <div className="ob-port-check-ok"><TickIcon /></div>
          <div><b>{porting.numbers} can be transferred</b> <span>· typically about 7 business days</span></div>
        </div>
      )}
      <div className="ob-porting-details">
        <div className="ob-step-eyebrow" style={{ marginBottom: 14 }}>Details from your current carrier</div>
        <div className="ob-field-row">
          <div><label className="ob-label">Number to bring over</label><input className="ob-input" placeholder="(555) 000-0000" value={porting.numbers} onChange={(e) => onPatch({ numbers: e.target.value })} /></div>
          <div><label className="ob-label">Current carrier</label><input className="ob-input" placeholder="AT&T, Spectrum…" value={porting.carrier} onChange={(e) => onPatch({ carrier: e.target.value })} /></div>
        </div>
        <div className="ob-field-row">
          <div><label className="ob-label">Account number</label><input className="ob-input" placeholder="Account #" value={porting.accountNumber} onChange={(e) => onPatch({ accountNumber: e.target.value })} /></div>
          <div><label className="ob-label">Porting PIN<span className="ob-label-optional">if any</span></label><input className="ob-input" placeholder="PIN" value={porting.portPin} onChange={(e) => onPatch({ portPin: e.target.value })} /></div>
        </div>
        <div className="ob-field"><label className="ob-label">Name on account</label><input className="ob-input" placeholder="As it appears on your phone bill" value={porting.nameOnAccount} onChange={(e) => onPatch({ nameOnAccount: e.target.value })} /></div>
        <div className="ob-field"><label className="ob-label">Street address on the bill</label><input className="ob-input" placeholder="123 Main St, Suite 2" value={porting.serviceAddress} onChange={(e) => onPatch({ serviceAddress: e.target.value })} /></div>
        <div className="ob-field-row" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
          <div><label className="ob-label">City</label><input className="ob-input" placeholder="City" value={porting.serviceCity} onChange={(e) => onPatch({ serviceCity: e.target.value })} /></div>
          <div><label className="ob-label">State</label><input className="ob-input" placeholder="NY" maxLength={2} value={porting.serviceState} onChange={(e) => onPatch({ serviceState: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") })} /></div>
          <div><label className="ob-label">ZIP</label><input className="ob-input" placeholder="10952" inputMode="numeric" maxLength={5} value={porting.serviceZip} onChange={(e) => onPatch({ serviceZip: e.target.value.replace(/\D/g, "") })} /></div>
        </div>
        <label className="ob-field" style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
          <input type="checkbox" checked={porting.isMobile} onChange={(e) => onPatch({ isMobile: e.target.checked })} style={{ width: 16, height: 16, accentColor: "#2f6bff", cursor: "pointer" }} />
          <span className="ob-label" style={{ marginBottom: 0 }}>This is a cell phone (wireless) number</span>
        </label>
        {porting.isMobile && (
          <div className="ob-field-hint" style={{ marginTop: -6, marginBottom: 14 }}>Cell transfers need the transfer PIN from your carrier — dial 611 or check their app if you don&apos;t have it.</div>
        )}
        <div className="ob-uploads">
          <label className={`ob-upl${porting.billFileName ? " done" : ""}`}>
            <input type="file" accept="application/pdf,image/*" style={{ display: "none" }} disabled={uploading.bill}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload("bill", f); }} />
            <div className="ob-upl-ic">{uploading.bill ? <div className="ob-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /> : porting.billFileName ? <TickIcon size={20} /> : <UploadIcon />}</div>
            <b>{porting.billFileName ? "Bill added" : "Recent phone bill"}</b>
            <span>{uploading.bill ? "Uploading…" : porting.billFileName || "PDF or photo"}</span>
          </label>
          {/* A ready-signed LOA is welcome but optional — the typed signature
              below is what lets us prepare and file one. */}
          <label className={`ob-upl${porting.loaFileName ? " done" : ""}`}>
            <input type="file" accept="application/pdf,image/*" style={{ display: "none" }} disabled={uploading.loa}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload("loa", f); }} />
            <div className="ob-upl-ic">{uploading.loa ? <div className="ob-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} /> : porting.loaFileName ? <TickIcon size={20} /> : <UploadIcon />}</div>
            <b>{porting.loaFileName ? "Authorization added" : "Signed authorization"}</b>
            <span>{uploading.loa ? "Uploading…" : porting.loaFileName || "Optional — we prepare one from your signature"}</span>
          </label>
        </div>
        <div className="ob-tx-card" style={{ marginTop: 14 }}>
          <div className="ob-tx-head">Authorize the transfer</div>
          <p className="ob-tx-lead">
            Your current carrier requires a signed Letter of Authorization before releasing the number.
            Type your full name to sign — we prepare and file the paperwork for you.
          </p>
          <input className="ob-input ob-sig" placeholder="Type your full name to sign" autoComplete="name"
            value={porting.loaSignature}
            onChange={(e) => onPatch({ loaSignature: e.target.value })} />
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="ob-tl-line"><span className="ob-tl-dot" />We file the transfer with your signed authorization</div>
          <div className="ob-tl-line"><span className="ob-tl-dot" />~7 business days — your number transfers (toll-free can take up to two weeks)</div>
          <div className="ob-tl-line"><span className="ob-tl-dot" />Transfer day — everything switches over by itself; nothing to do</div>
        </div>
      </div>
    </>
  );
}

/** The scoped extension editor validation (no owner rule — these people join
 *  an EXISTING account, nobody here becomes the admin). */
export function validateScopedExtensions(exts: WizExtension[]): string | null {
  if (!exts.length) return "Add at least one person.";
  const seen = new Set<string>();
  for (const e of exts) {
    if (e.displayName.trim().length < 1) return "Each person needs a name.";
    if (!/^\d{3,6}$/.test(e.extNumber.trim())) {
      return `Extension number "${e.extNumber || "(empty)"}" won't work — use at least three digits, like 101.`;
    }
    if (seen.has(e.extNumber.trim())) return "Extension numbers must be unique.";
    seen.add(e.extNumber.trim());
    if (e.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email.trim())) {
      return `The email for ${e.displayName.trim() || "extension " + (e.extNumber || "?")} doesn't look right — fix it or leave it blank.`;
    }
    if (e.cellMode && e.cellNumber.replace(/\D/g, "").replace(/^1/, "").length !== 10) {
      return `Enter a full cell phone number for ${e.displayName.trim() || "extension " + (e.extNumber || "?")}.`;
    }
  }
  return null;
}

function DoneCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="ob-card">
      <div className="ob-illustration"><TickIcon size={24} /></div>
      <h1 className="ob-step-title">{title}</h1>
      <p className="ob-step-subtitle">{body}</p>
    </div>
  );
}

export function PortOnlyFlow(props: {
  porting: PortingFields;
  onPatch: (patch: Partial<PortingFields>) => void;
  portability: "idle" | "checking" | "portable" | "unknown";
  uploading: { loa: boolean; bill: boolean };
  onUpload: (kind: "loa" | "bill", file: File) => void;
  onSubmit: () => Promise<void>;
  busy: boolean;
  done: boolean;
  error: string | null;
}) {
  if (props.done) {
    return (
      <DoneCard
        title="Your transfer request is in"
        body="We have everything we need — we'll prepare and file the paperwork with your signed authorization, and your number transfers in about 7 business days. Your current number keeps working the whole time; we'll be in touch if the carrier needs anything else."
      />
    );
  }
  return (
    <div className="ob-card">
      <div className="ob-step-eyebrow">Number transfer</div>
      <h1 className="ob-step-title">Bring your number to Loopcom</h1>
      <p className="ob-step-subtitle">
        Everything below comes straight off a recent bill from your current carrier — takes about two minutes,
        and we file the whole transfer for you.
      </p>
      <PortDetailsSection
        porting={props.porting}
        onPatch={props.onPatch}
        portability={props.portability}
        uploading={props.uploading}
        onUpload={props.onUpload}
      />
      {props.error && <div className="ob-error">{props.error}</div>}
      <div className="ob-actions">
        <div />
        <button className="ob-btn-next" disabled={props.busy} onClick={() => void props.onSubmit()}>
          {props.busy ? "Submitting…" : "Submit my transfer"}
        </button>
      </div>
    </div>
  );
}

export function ExtensionOnlyFlow(props: {
  extensions: WizExtension[];
  onUpdate: (i: number, patch: Partial<WizExtension>) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  theme: "dark" | "light";
  onSubmit: () => Promise<void>;
  busy: boolean;
  done: boolean;
  error: string | null;
}) {
  if (props.done) {
    return (
      <DoneCard
        title="Got it — your people are on the way"
        body="We've received the request and we'll set the new extensions up on your phone system. Anyone you gave an email address will receive their login and app invitation once their extension is ready."
      />
    );
  }
  return (
    <div className="ob-card">
      <div className="ob-step-eyebrow">Your team</div>
      <h1 className="ob-step-title">Add people to your phone system</h1>
      <p className="ob-step-subtitle">
        Each person gets their own extension — add an email and they&apos;ll receive their login and the app.
      </p>
      <div className="ob-mfields" style={{ marginTop: 4 }}>
        {props.extensions.map((ext, i) => (
          <div key={i} className="ob-mperson">
            <div className="ob-mperson-head">
              <span className="ob-label" style={{ marginBottom: 0 }}>Person {i + 1}</span>
              {props.extensions.length > 1 && (
                <button className="ob-ext-remove" onClick={() => props.onRemove(i)} title="Remove">×</button>
              )}
            </div>
            <div className="ob-mrow2">
              <div><label className="ob-label">Name</label><input className="ob-input" placeholder="Jane Smith" value={ext.displayName} onChange={(e) => props.onUpdate(i, { displayName: e.target.value })} /></div>
              <div><label className="ob-label">Ext #</label><input className="ob-input" placeholder="101" inputMode="numeric" value={ext.extNumber}
                onChange={(e) => props.onUpdate(i, { extNumber: e.target.value.replace(/\D/g, "") })} /></div>
            </div>
            <div><label className="ob-label">Email <span className="ob-label-optional">optional — where their login goes</span></label>
              <input className="ob-input" type="email" placeholder="jane@acme.com" value={ext.email} onChange={(e) => props.onUpdate(i, { email: e.target.value })} /></div>
            <div className="ob-ext-cell">
              <ConnectSelect
                className="ob-ext-cell-select"
                value={ext.cellMode}
                onChange={(v) => props.onUpdate(i, { cellMode: v as CellMode, cellNumber: v ? ext.cellNumber : "" })}
                theme={props.theme}
                options={[
                  { value: "", label: "Rings their desk phone & app" },
                  { value: "also", label: "Also rings their cell phone" },
                  { value: "only", label: "Goes straight to their cell phone" },
                ]}
              />
              {ext.cellMode && (
                <input className="ob-input ob-ext-cell-input" placeholder="Cell number — (555) 000-0000" value={ext.cellNumber}
                  onChange={(e) => props.onUpdate(i, { cellNumber: e.target.value })} />
              )}
            </div>
          </div>
        ))}
        <button className="ob-mcard ob-madd" onClick={props.onAdd}>+ Add another person</button>
      </div>
      {props.error && <div className="ob-error">{props.error}</div>}
      <div className="ob-actions">
        <div />
        <button className="ob-btn-next" disabled={props.busy} onClick={() => void props.onSubmit()}>
          {props.busy ? "Submitting…" : `Add ${props.extensions.length === 1 ? "this person" : "these people"}`}
        </button>
      </div>
    </div>
  );
}
