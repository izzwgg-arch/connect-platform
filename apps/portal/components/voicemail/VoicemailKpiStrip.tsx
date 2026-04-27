"use client";

import { Inbox, Clock, Flame, Mail } from "lucide-react";

type Props = {
  loading: boolean;
  total: number;
  newCount: number;
  urgentCount: number;
  staleCount: number;
};

export function VoicemailKpiStrip({ loading, total, newCount, urgentCount, staleCount }: Props) {
  const cards = [
    { label: "Total", value: total, icon: Inbox, hint: "Across inbox, urgent, and old" },
    { label: "New", value: newCount, icon: Mail, hint: "Unread messages" },
    { label: "Urgent", value: urgentCount, icon: Flame, hint: "Marked urgent" },
    { label: "Older than 7 days", value: staleCount, icon: Clock, hint: "Received over a week ago" },
  ] as const;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 12,
        marginBottom: 4,
      }}
      className="vm-kpi-grid"
    >
      <style>{`
        @media (max-width: 900px) {
          .vm-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }
        @media (max-width: 480px) {
          .vm-kpi-grid { grid-template-columns: 1fr !important; }
        }
        @keyframes vmKpiPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(34, 168, 255, 0); }
          50% { box-shadow: 0 0 0 4px rgba(34, 168, 255, 0.12); }
        }
        .vm-kpi-card:hover {
          transform: translateY(-1px);
          border-color: rgba(34, 168, 255, 0.35);
        }
      `}</style>
      {cards.map((c) => (
        <div
          key={c.label}
          className="vm-kpi-card"
          title={c.hint}
          style={{
            borderRadius: 16,
            border: "1px solid var(--border)",
            background: "linear-gradient(145deg, var(--panel-2), var(--panel))",
            padding: "14px 16px",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            transition: "transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease",
            boxShadow: "0 4px 18px rgba(0,0,0,0.04)",
            animation: loading ? "vmKpiPulse 1.6s ease-in-out infinite" : undefined,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(34,168,255,0.1)",
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            <c.icon size={20} strokeWidth={2} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {c.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 750, marginTop: 4, letterSpacing: "-0.03em" }}>
              {loading ? "—" : c.value.toLocaleString()}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
