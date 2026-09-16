"use client";
/**
 * Creative Studio — the brand kit.
 *
 * The look everything is made in. Saving it is gated by
 * can_manage_creative_brand_kit, so a person who can make things cannot
 * silently change what the whole company's work looks like.
 */
import { useCallback, useEffect, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPut } from "../../../../services/apiClient";
import { Card, EmptyState, LoadingCard, Note, PageHead, Pill, errText } from "../CreativeUi";

interface Item {
  type: string;
  label: string;
  value: any;
  assetId?: string;
}

export default function CreativeBrandPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("Our brand");
  const [colors, setColors] = useState<Item[]>([]);
  const [fonts, setFonts] = useState<Item[]>([]);
  const [voice, setVoice] = useState("");
  const [prohibitions, setProhibitions] = useState<string[]>([]);
  const [claims, setClaims] = useState<string[]>([]);
  const [ctas, setCtas] = useState<string[]>([]);
  const [legal, setLegal] = useState("");

  const load = useCallback(async () => {
    try {
      const res: any = await apiGet("/creative/brand-kit");
      const kit = res.brandKit;
      setName(kit.name || "Our brand");
      const items: Item[] = kit.items || [];
      setColors(items.filter((i) => i.type === "color"));
      setFonts(items.filter((i) => i.type === "font"));
      const g = kit.guidance || {};
      setVoice(g.voice || "");
      setProhibitions(g.prohibitions || []);
      setClaims(g.claims || []);
      setCtas(g.ctas || []);
      setLegal(g.legal || "");
      setErr("");
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setErr("");
    setNote("");
    try {
      await apiPut("/creative/brand-kit", {
        name,
        guidance: { voice, prohibitions, claims, ctas, legal },
        items: [
          ...colors.filter((c) => c.label && c.value?.hex).map((c) => ({ type: "color", label: c.label, value: { hex: c.value.hex } })),
          ...fonts.filter((f) => f.label).map((f) => ({ type: "font", label: f.label, value: { family: f.value?.family || f.label } })),
        ],
      });
      setNote("Saved. Everything made from now on uses this.");
      load();
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const listEditor = (label: string, values: string[], set: (v: string[]) => void, placeholder: string) => (
    <div>
      <div className="cse-seclbl">{label}</div>
      <div className="cse-stack" style={{ gap: 6 }}>
        {values.map((v, i) => (
          <div key={i} className="cse-row" style={{ gap: 6 }}>
            <input
              className="cse-input"
              value={v}
              onChange={(e) => set(values.map((x, k) => (k === i ? e.target.value : x)))}
            />
            <button type="button" className="cse-btn sm ghost" onClick={() => set(values.filter((_, k) => k !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="cse-btn sm" onClick={() => set([...values, ""])}>
          Add
        </button>
        {!values.length ? <span className="cse-help">{placeholder}</span> : null}
      </div>
    </div>
  );

  return (
    <PermissionGate permission="can_view_creative_brand_kit" fallback={<div className="cse"><EmptyState title="The brand kit isn't on for your account" text="An admin at your company can switch it on." /></div>}>
      <div className="cse">
        <PageHead
          title="Brand kit"
          crumb={["Creative Studio", "Brand kit"]}
          subtitle="The look everything is made in. Only your company can see it, and every picture, video and design the studio makes starts from it."
          actions={
            <button type="button" className="cse-btn primary" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
          }
        />

        {err ? <Note kind="bad">{err}</Note> : null}
        {note ? <Note kind="ok">{note}</Note> : null}

        {loading ? (
          <LoadingCard rows={3} />
        ) : (
          <div className="cse-grid g2" style={{ alignItems: "start" }}>
            <div className="cse-stack">
              <Card title="Colours" sub="Used in everything the studio makes">
                <div className="cse-stack" style={{ gap: 8 }}>
                  {colors.map((c, i) => (
                    <div key={i} className="cse-row" style={{ gap: 8 }}>
                      <input
                        type="color"
                        value={c.value?.hex || "#22a8ff"}
                        onChange={(e) => setColors(colors.map((x, k) => (k === i ? { ...x, value: { hex: e.target.value } } : x)))}
                        style={{ width: 44, height: 34, border: "1px solid var(--border)", borderRadius: 8, background: "none", padding: 2 }}
                        aria-label={`Colour ${i + 1}`}
                      />
                      <input
                        className="cse-input"
                        placeholder="What it is called"
                        value={c.label}
                        onChange={(e) => setColors(colors.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))}
                      />
                      <span className="cse-mono cse-help">{c.value?.hex}</span>
                      <button type="button" className="cse-btn sm ghost" onClick={() => setColors(colors.filter((_, k) => k !== i))}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="cse-btn sm" onClick={() => setColors([...colors, { type: "color", label: "", value: { hex: "#22a8ff" } }])}>
                    Add a colour
                  </button>
                </div>
              </Card>

              <Card title="Fonts">
                <div className="cse-stack" style={{ gap: 8 }}>
                  {fonts.map((f, i) => (
                    <div key={i} className="cse-row" style={{ gap: 8 }}>
                      <input
                        className="cse-input"
                        placeholder="Font name"
                        value={f.label}
                        onChange={(e) => setFonts(fonts.map((x, k) => (k === i ? { ...x, label: e.target.value, value: { family: e.target.value } } : x)))}
                      />
                      <button type="button" className="cse-btn sm ghost" onClick={() => setFonts(fonts.filter((_, k) => k !== i))}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button type="button" className="cse-btn sm" onClick={() => setFonts([...fonts, { type: "font", label: "", value: {} }])}>
                    Add a font
                  </button>
                </div>
              </Card>

              <Card title="Name">
                <input className="cse-input" value={name} onChange={(e) => setName(e.target.value)} />
              </Card>
            </div>

            <div className="cse-stack">
              <Card title="How we write" sub="Applied to headlines and voiceovers">
                <textarea
                  className="cse-input"
                  rows={3}
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  placeholder="Plain English. Short sentences. Never call it AI-powered — say what it does."
                />
              </Card>

              <Card title="Never do this" sub="Turned into instructions the engine must avoid">
                {listEditor("Prohibited", prohibitions, setProhibitions, "For example: neon gradients, stock smiles, comic fonts.")}
              </Card>

              <Card title="Approved lines and buttons">
                {listEditor("Lines we are allowed to claim", claims, setClaims, "For example: answers your phones day and night.")}
                <div className="cse-divider" />
                {listEditor("Buttons we use", ctas, setCtas, "For example: Talk to us.")}
              </Card>

              <Card title="Small print">
                <textarea className="cse-input" rows={2} value={legal} onChange={(e) => setLegal(e.target.value)} placeholder="Anything that must appear on an advert." />
              </Card>
            </div>
          </div>
        )}

        <Note kind="info">
          <div>
            <b>Separation is enforced on the server.</b> A request for another company&apos;s brand kit comes back as “not found”, whether it comes
            from a person, the Coworker, or a link somebody was sent.
          </div>
        </Note>
      </div>
    </PermissionGate>
  );
}
