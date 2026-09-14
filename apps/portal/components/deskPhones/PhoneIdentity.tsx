"use client";

/**
 * TELLING US WHAT A PHONE IS — the two pickers, and the drawing of where to look.
 *
 * ⛔⛔ WHY IT MATTERS: a phone whose model the phone system cannot name gets NO
 * `provisioning.devices` row, so the standing PnP listener has nothing to answer, so a
 * factory-reset handset multicasts its request and is met with silence. The refusal that
 * produces says "Tell us the make and model on the back of this phone" — these controls
 * are the only way anyone can.
 *
 * ⛔ THE DRAWING IS THE HALF PEOPLE ACTUALLY NEED. Almost nobody knows their phone's model
 * and almost everybody can read a label once they are told where it is — it is on the
 * UNDERSIDE, which means picking the handset up, which is not obvious from a screen. A
 * picker with no picture is a question most people cannot answer.
 */
import { useMemo } from "react";
import { ConnectSelect } from "../ConnectSelect";
import { makeOptions, modelOptionsFor, PICKER_UNSURE } from "@connect/shared";

/**
 * The back of a desk phone, label side up, with the two lines that matter called out.
 *
 * ⛔ Drawn rather than photographed on purpose: there are 427 models and the label sits in
 * a different place on most of them, so ANY photo would be wrong for almost every reader.
 * A drawing says "a white label, underneath, with these two lines on it", which is true of
 * all of them.
 */
export function StickerDrawing() {
  return (
    <svg width="100%" height="148" viewBox="0 0 300 148" fill="none" role="img"
         aria-label="The underside of a desk phone, showing a white label printed with the model and the MAC address">
      {/* the handset, tipped over so the base faces us */}
      <g stroke="var(--dps-accent)" strokeWidth="1.8" fill="none">
        <rect x="26" y="20" width="132" height="108" rx="9" fill="var(--dps-panel)" />
        {/* the two rubber feet, which is what a person sees when they turn it over */}
        <circle cx="46" cy="40" r="5" fill="var(--dps-accent)" opacity=".18" stroke="none" />
        <circle cx="138" cy="40" r="5" fill="var(--dps-accent)" opacity=".18" stroke="none" />
        <circle cx="46" cy="108" r="5" fill="var(--dps-accent)" opacity=".18" stroke="none" />
        <circle cx="138" cy="108" r="5" fill="var(--dps-accent)" opacity=".18" stroke="none" />
        {/* the label */}
        <rect x="56" y="58" width="72" height="34" rx="3" fill="var(--dps-accent)" opacity=".14" stroke="none" />
        <rect x="56" y="58" width="72" height="34" rx="3" />
        <path d="M62 68 H104" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M62 78 H116" strokeWidth="2.2" strokeLinecap="round" opacity=".65" />
        <path d="M62 85 H96" strokeWidth="2.2" strokeLinecap="round" opacity=".45" />
      </g>
      <text x="92" y="140" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">turn the phone over</text>

      {/* what the lines say */}
      <path d="M132 68 H196" stroke="var(--dps-accent)" strokeWidth="1.6" strokeDasharray="3 3" />
      <text x="202" y="72" fontSize="11.5" fontWeight="600" fill="var(--dps-accent)">the model</text>
      <text x="202" y="86" fontSize="10.5" fill="var(--dps-dim)">like T53W or GXP2170</text>
      <path d="M132 82 H196" stroke="var(--dps-accent)" strokeWidth="1.6" strokeDasharray="3 3" opacity=".5" />
      <text x="202" y="106" fontSize="11" fill="var(--dps-dim)">the long code below it</text>
      <text x="202" y="119" fontSize="10.5" fill="var(--dps-dim)">is the phone&rsquo;s own number</text>
    </svg>
  );
}

export type IdentityPickerProps = {
  make: string;
  model: string;
  onMake: (v: string) => void;
  onModel: (v: string) => void;
  /** Shown under the pickers when the last attempt was refused. */
  error?: string | null;
  disabled?: boolean;
  /** Compact form for a phone row; the roomy one is the wizard step. */
  size?: "sm" | "md";
  idPrefix?: string;
};

/**
 * The two pickers.
 *
 * ⛔⛔ NOT KNOWING THE MAKE MUST NOT BE A DEAD END. Leaving the make on "I am not sure"
 * offers EVERY model, each labelled with its brand — a person who cannot find a brand name
 * on the front can almost always read a model off the label, and the model names the make
 * by itself. Demanding the make first would be asking for the harder fact.
 *
 * ⛔ Both lists come from the phone system's own catalogue, never a list typed here: a make
 * we cannot provision must not be offered, and one the PBX gains later must appear without
 * anyone editing this file.
 */
export function IdentityPicker({
  make, model, onMake, onModel, error, disabled, size = "md", idPrefix = "dps-id",
}: IdentityPickerProps) {
  const makes = useMemo(
    () => [
      ...makeOptions().map((m) => ({ value: m.value as string, label: m.label })),
      { value: PICKER_UNSURE, label: "I am not sure — show me all of them" },
    ],
    [],
  );

  const models = useMemo(() => {
    const opts = modelOptionsFor(make);
    return [
      { value: "", label: "Pick the model…" },
      ...opts.map((o) => ({
        value: o.value,
        // ⛔ A model the phone system has no settings file for is still OFFERED and says so.
        // Hiding it sends somebody hunting a list that silently does not contain their
        // phone, which is a worse hour than being told the truth in one line.
        label: o.setupSupported ? o.label : `${o.label} — Loopcom sets this one up for you`,
      })),
    ];
  }, [make]);

  return (
    <div className="dps-idpick">
      <label className="dps-flabel" htmlFor={`${idPrefix}-make`}>Who makes it?</label>
      <ConnectSelect
        id={`${idPrefix}-make`}
        size={size}
        value={make}
        onChange={(v) => {
          onMake(v);
          // ⛔ Changing the make clears the model: the list is about to be replaced, and a
          // model left behind from another brand is the one combination the server refuses.
          onModel("");
        }}
        ariaLabel="The make of this phone"
        searchable
        disabled={disabled}
        options={makes}
      />
      <label className="dps-flabel" htmlFor={`${idPrefix}-model`} style={{ marginTop: 10 }}>
        And which one is it?
      </label>
      <ConnectSelect
        id={`${idPrefix}-model`}
        size={size}
        value={model}
        onChange={onModel}
        ariaLabel="The model of this phone"
        searchable
        disabled={disabled}
        options={models}
      />
      {error && <p className="dps-hint" style={{ color: "var(--dps-warn)", marginTop: 8 }}>{error}</p>}
    </div>
  );
}
