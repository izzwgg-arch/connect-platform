"use client";
/**
 * LoopCom Mobile — Plans (customer). Retail catalog only — wholesale cost
 * and margin exist solely in the owner console. Carrier truth stays on the
 * card (talk = beta, texts = coming). Gated by can_view_mobile_plans.
 */
import { useCallback, useEffect, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet } from "../../../../services/apiClient";
import { EmptyState, LoadingCard, Note, PageHead, errText, gb, money } from "../MobileUi";

type Plan = {
  id: string; name: string; description: string | null; monthlyPriceCents: number;
  activationFeeCents: number; simFeeCents: number; esimFeeCents: number;
  includedDataMb: number | null; includedVoiceMinutes: number | null; includedSms: number | null;
  dataOverageBehavior: string; dataOverageCentsPerGb: number; roamingEnabled: boolean;
};

export default function MobilePlansPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [linesOn, setLinesOn] = useState<Record<string, number>>({});
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await apiGet<{ plans: Plan[] }>("/mobile-service/plans");
      setPlans(out.plans ?? []);
      // Count of the tenant's lines per plan — from the dashboard payload if
      // the holder also has it; failures here are cosmetic.
      const dash = await apiGet<any>("/mobile-service/dashboard").catch(() => null);
      if (dash?.lines) {
        const counts: Record<string, number> = {};
        for (const l of dash.lines) if (l.plan?.id && l.status !== "terminated") counts[l.plan.id] = (counts[l.plan.id] ?? 0) + 1;
        setLinesOn(counts);
      }
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load plans.") });
      setPlans([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <PermissionGate permission="can_view_mobile_plans" fallback={<div className="lmx"><EmptyState title="No access to Plans" text="Ask your account owner to grant the Plans page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead title="Plans" subtitle="Simple monthly pricing, taxes included in the advertised price. Changes apply immediately with fair proration — move a line from the Lines page." />
        <Note note={note} />
        {!plans ? <LoadingCard rows={4} /> : plans.length === 0 ? (
          <EmptyState title="Plans are being finalized" text="LoopCom is publishing mobile plans for your account. You'll get an email the moment they're live." />
        ) : (
          <div className="g3">
            {plans.map((p, idx) => {
              const popular = idx === Math.min(1, plans.length - 1) && plans.length > 1;
              return (
                <div key={p.id} className="lcard" style={{ display: "flex", flexDirection: "column", gap: 10, ...(popular ? { borderColor: "color-mix(in srgb, var(--accent) 50%, var(--border))", boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent), var(--lmx-shadow)" } : {}) }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <b style={{ fontSize: 15 }}>{p.name}</b>
                    <span className="row" style={{ gap: 6 }}>
                      {popular ? <span className="tag new">Most popular</span> : null}
                      {linesOn[p.id] ? <span className="tag">{linesOn[p.id]} line{linesOn[p.id] === 1 ? "" : "s"} on this</span> : null}
                    </span>
                  </div>
                  <div><span style={{ fontSize: 28, fontWeight: 750 }}>{money(p.monthlyPriceCents).replace(/\.00$/, "")}</span><span className="dimtx">/line/mo</span></div>
                  <div className="tl" style={{ fontSize: 13 }}>
                    <FeatureRow ok text={p.includedDataMb != null ? `${gb(p.includedDataMb)} high-speed data` : "No data (voice/text line)"} />
                    <FeatureRow ok={p.includedVoiceMinutes !== 0} text={<>Talk {p.includedVoiceMinutes == null ? "unlimited" : `${p.includedVoiceMinutes} min`} <span className="tag beta">carrier beta</span></>} />
                    <FeatureRow ok={p.includedSms !== 0} text={<>Texts {p.includedSms == null ? "unlimited" : p.includedSms} <span className="tag">coming</span></>} />
                    <FeatureRow ok={p.roamingEnabled} text={p.roamingEnabled ? "Roaming included" : "No roaming"} dim={!p.roamingEnabled} />
                  </div>
                  <div className="dimtx small">
                    {p.dataOverageBehavior === "charge" && p.dataOverageCentsPerGb > 0
                      ? `Overage ${money(p.dataOverageCentsPerGb)}/GB`
                      : "Data slows after the allowance — nothing extra billed"}
                    {" · "}eSIM {p.esimFeeCents > 0 ? money(p.esimFeeCents) : "free"} · physical SIM {p.simFeeCents > 0 ? money(p.simFeeCents) : "free"}
                    {p.activationFeeCents > 0 ? ` · activation ${money(p.activationFeeCents)}` : ""}
                  </div>
                  {p.description ? <div className="dimtx small">{p.description}</div> : null}
                </div>
              );
            })}
          </div>
        )}
        {plans && plans.length > 0 ? (
          <p className="dimtx small" style={{ marginTop: 12 }}>To move a line to a different plan, open <b>Lines</b> and use the Plan button on the line — the exact prorated price shows before you confirm.</p>
        ) : null}
      </div>
    </PermissionGate>
  );
}

function FeatureRow({ ok = true, dim = false, text }: { ok?: boolean; dim?: boolean; text: React.ReactNode }) {
  return (
    <div className="tlrow" style={{ padding: "3px 0", gridTemplateColumns: "20px 1fr" }}>
      <span className={`ti ${ok && !dim ? "ok" : ""}`} style={{ width: 18, height: 18, ...(dim ? { background: "var(--lmx-chip)", color: "var(--text-dim)" } : {}) }}>{ok && !dim ? "✓" : "–"}</span>
      <div className={dim ? "dimtx" : undefined}>{text}</div>
    </div>
  );
}
