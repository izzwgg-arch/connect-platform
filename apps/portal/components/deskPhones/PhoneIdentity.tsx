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

/**
 * The same underside, with the SERIAL NUMBER line called out instead of the model.
 *
 * ⛔ Drawn, not photographed, for the same reason as the sibling above — and for one more: a
 * photograph of a real handset's label is somebody else's copyrighted image, and it would carry a
 * real serial number into a product screen. A drawing shows the one thing a person needs: a white
 * label on the UNDERSIDE, a line that begins `S/N`, and a barcode beside it they can scan instead
 * of typing. Grandstream's own documentation puts that label on the bottom of the phone and on the
 * original box, which is exactly what this depicts.
 *
 * ⛔ The example characters are deliberately not a real serial: the point is the SHAPE of the line
 * ("S/N" then a long code), not a value anyone should copy.
 */
export function SerialStickerDrawing() {
  return (
    <svg width="100%" height="164" viewBox="0 0 300 164" fill="none" role="img"
         aria-label="The underside of a desk phone, showing a white label with a line beginning S slash N, the serial number, next to a barcode">
      <g stroke="var(--dps-accent)" strokeWidth="1.8" fill="none">
        {/* the handset, tipped over so the base faces us */}
        <rect x="20" y="22" width="140" height="112" rx="9" fill="var(--dps-panel)" />
        {/* the rubber feet — what a person actually sees when they turn it over */}
        <circle cx="41" cy="43" r="5" fill="var(--dps-accent)" opacity=".18" stroke="none" />
        <circle cx="139" cy="43" r="5" fill="var(--dps-accent)" opacity=".18" stroke="none" />
        <circle cx="41" cy="113" r="5" fill="var(--dps-accent)" opacity=".18" stroke="none" />
        <circle cx="139" cy="113" r="5" fill="var(--dps-accent)" opacity=".18" stroke="none" />
        {/* the white label */}
        <rect x="46" y="58" width="88" height="46" rx="3" fill="var(--dps-panel-2)" />
        <rect x="46" y="58" width="88" height="46" rx="3" />
        {/* the model line and the MAC line, dimmed — they are not what this screen wants */}
        <path d="M52 67 H92" strokeWidth="2.4" strokeLinecap="round" opacity=".35" />
        <path d="M52 75 H104" strokeWidth="2.2" strokeLinecap="round" opacity=".3" />
      </g>
      {/* ⛔ THE S/N LINE IS THE ONE THING THIS DRAWING IS FOR — highlighted, everything else dimmed.
          ⛔ `S/N` and the code are ONE text element with a tab-free gap rather than two positioned
          ones: two elements collided the moment the monospace stack fell back to a serif face. */}
      <rect x="49" y="79" width="80" height="13" rx="2" fill="var(--dps-accent)" opacity=".16" />
      <text x="53" y="88.5" fontSize="8.5" fill="var(--dps-accent)" fontFamily="ui-monospace, Consolas, monospace">
        <tspan fontWeight="700">S/N</tspan>
        <tspan dx="5">20EZ…5F</tspan>
      </text>
      {/* the barcode under it: what a scanner reads instead of anyone typing.
          ⛔ Literal bars, not a .map() — so this file IS the picture, and what gets reviewed is
          exactly what ships. */}
      <g fill="var(--dps-accent)" opacity=".7">
        <rect x="53" y="94.5" width="2.2" height="5.5" /><rect x="57" y="94.5" width="1.1" height="5.5" />
        <rect x="60" y="94.5" width="1.1" height="5.5" /><rect x="63" y="94.5" width="2.2" height="5.5" />
        <rect x="67" y="94.5" width="1.1" height="5.5" /><rect x="70" y="94.5" width="1.1" height="5.5" />
        <rect x="73" y="94.5" width="2.2" height="5.5" /><rect x="77" y="94.5" width="1.1" height="5.5" />
        <rect x="80" y="94.5" width="1.1" height="5.5" /><rect x="83" y="94.5" width="2.2" height="5.5" />
        <rect x="87" y="94.5" width="1.1" height="5.5" /><rect x="90" y="94.5" width="1.1" height="5.5" />
        <rect x="93" y="94.5" width="2.2" height="5.5" /><rect x="97" y="94.5" width="1.1" height="5.5" />
        <rect x="100" y="94.5" width="1.1" height="5.5" /><rect x="103" y="94.5" width="2.2" height="5.5" />
        <rect x="107" y="94.5" width="1.1" height="5.5" /><rect x="110" y="94.5" width="1.1" height="5.5" />
        <rect x="113" y="94.5" width="2.2" height="5.5" /><rect x="117" y="94.5" width="1.1" height="5.5" />
        <rect x="120" y="94.5" width="1.1" height="5.5" /><rect x="124" y="94.5" width="2.2" height="5.5" />
      </g>
      <text x="90" y="150" fontSize="11" fill="var(--dps-dim)" textAnchor="middle">turn the phone over</text>

      {/* the callouts */}
      <path d="M134 86 H188" stroke="var(--dps-accent)" strokeWidth="1.6" strokeDasharray="3 3" />
      <text x="194" y="82" fontSize="11.5" fontWeight="600" fill="var(--dps-accent)">the serial number</text>
      <text x="194" y="96" fontSize="10.5" fill="var(--dps-dim)">the line starting S/N</text>
      <path d="M134 98 H188" stroke="var(--dps-accent)" strokeWidth="1.6" strokeDasharray="3 3" opacity=".5" />
      <text x="194" y="116" fontSize="10.5" fill="var(--dps-dim)">or scan the barcode</text>
      <text x="194" y="129" fontSize="10.5" fill="var(--dps-dim)">next to it</text>
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
