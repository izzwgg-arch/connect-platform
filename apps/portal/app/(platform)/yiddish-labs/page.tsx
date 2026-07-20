"use client";
/**
 * Yiddish Labs — dedicated owner page. Auto-detected Yiddish/English call
 * transcription: status, language breakdown, recent transcripts. Consumes
 * /agent-api/yiddishlabs/* (owner JWT).
 */
import { useCallback, useEffect, useState } from "react";

type Status = { configured: boolean; webhookConfigured: boolean; counts: Record<string, number> };
type T = { recordingId: string; language?: string | null; text: string; source: string; reviewStatus: string; createdAt: string };

function token() { return typeof window === "undefined" ? "" : (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || ""); }
async function api<T>(p: string): Promise<T> {
  const r = await fetch(`/agent-api${p}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

const langPill: Record<string, { bg: string; c: string; label: string }> = {
  yi: { bg: "#241d3d", c: "#a78bfa", label: "ייִדיש" },
  en: { bg: "#12331f", c: "#22c55e", label: "English" },
  "yi-en": { bg: "#1c2330", c: "#60a5fa", label: "yi-en" },
  he: { bg: "#3a2c0d", c: "#f59e0b", label: "עברית" },
};

export default function YiddishLabsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [rows, setRows] = useState<T[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/yiddishlabs/status"));
      setRows((await api<{ transcripts: T[] }>("/yiddishlabs/recent")).transcripts);
      setErr(null);
    } catch { setErr("Owners only, or the agent is unreachable."); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const isYi = (l?: string | null) => l === "yi" || l === "yi-en" || l === "he";

  return (
    <div style={{ maxWidth: 940, margin: "0 auto", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Yiddish Labs</h1>
        {status && <span style={{ ...pill, background: status.configured ? "#12331f" : "#3b1417", color: status.configured ? "#22c55e" : "#ef4444" }}>{status.configured ? "connected" : "no API key"}</span>}
      </div>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>Automatic Yiddish/English detection on every call recording. Yiddish in → Yiddish transcript; English in → English. Feeds the tuning corpus.</div>
      {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {status && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          {(["yi", "en", "yi-en", "he"] as const).map((l) => (
            <div key={l} style={{ flex: 1, minWidth: 130, border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: langPill[l].c }}>{status.counts[l] ?? 0}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{langPill[l].label} transcripts</div>
            </div>
          ))}
        </div>
      )}
      {status && !status.webhookConfigured && (
        <div style={{ border: "1px solid rgba(245,158,11,.4)", borderRadius: 8, padding: 10, fontSize: 12.5, marginBottom: 14, color: "#f59e0b" }}>
          Webhook secret not set — long recordings (&gt;5 min) complete via webhook. Set YIDDISHLABS_WEBHOOK_SECRET to enable.
        </div>
      )}

      <h3 style={{ fontSize: 14, marginBottom: 8 }}>Recent transcriptions</h3>
      {rows.length === 0 ? (
        <div style={{ opacity: 0.6, fontSize: 13 }}>No Yiddish Labs transcripts yet. They appear here once the API key is set and calls come in.</div>
      ) : rows.map((t) => {
        const lp = langPill[t.language ?? "en"] ?? langPill.en;
        return (
          <div key={t.recordingId} style={{ border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: 12, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
              <span style={{ ...pill, background: lp.bg, color: lp.c }}>{lp.label}</span>
              <span style={{ fontSize: 12, opacity: 0.6 }}>{new Date(t.createdAt).toLocaleString()} · {t.source}{t.reviewStatus === "pending" ? " · needs review" : ""}</span>
            </div>
            <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap", direction: isYi(t.language) ? "rtl" : "ltr", textAlign: isYi(t.language) ? "right" : "left" }}>{t.text.slice(0, 400)}{t.text.length > 400 ? "…" : ""}</div>
          </div>
        );
      })}
    </div>
  );
}

const pill: React.CSSProperties = { padding: "2px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600 };
