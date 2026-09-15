"use client";
/**
 * LoopCom Mobile — Mobile Support. Diagnostics run first, the result
 * explains itself in plain English, and the fix is a button on the finding.
 * Requests file into the EXISTING support system (no second stack).
 * Gated by can_view_mobile_support.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy } from "lucide-react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet } from "../../../../services/apiClient";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { EmptyState, LoadingCard, Note, PageHead, errText, fmtDateTime } from "../MobileUi";

type Diag = {
  line: { id: string; phoneNumber: string | null; label: string; status: string };
  checks: Array<{ check: string; result: "pass" | "warn" | "fail" | "skip"; detail: string }>;
  nextStep: { action: string; text: string } | null;
  lastEvent: { eventType: string; receivedAt: string } | null;
};

export default function MobileSupportPage() {
  const router = useRouter();
  const [lines, setLines] = useState<Array<{ id: string; phoneNumber: string | null; label: string }> | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      // The dashboard payload carries the line list; support holders usually
      // hold the dashboard too. Fall back gracefully when they don't.
      const dash = await apiGet<any>("/mobile-service/dashboard").catch(() => null);
      const ls = (dash?.lines ?? []).map((l: any) => ({ id: l.id, phoneNumber: l.phoneNumber, label: l.label }));
      setLines(ls);
      if (ls.length > 0) setPick(ls[0].id);
    } catch {
      setLines([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    if (!pick) return;
    setRunning(true);
    setNote(null);
    try {
      setDiag(await apiGet<Diag>(`/mobile-service/support/diagnostics/${pick}`));
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't run diagnostics.") });
    } finally {
      setRunning(false);
    }
  };

  return (
    <PermissionGate permission="can_view_mobile_support" fallback={<div className="lmx"><EmptyState title="No access to Mobile Support" text="Ask your account owner to grant the Support page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead
          title="Mobile Support"
          subtitle="Fix the common things yourself in one click — or hand it to us with the diagnostics already attached."
          actions={<button className="lbtn primary" onClick={() => router.push("/support-chat")}><LifeBuoy size={15} /> New support request</button>}
        />
        <Note note={note} />

        <div className="g3">
          <div className="lcard">
            <div className="lcard-h"><h3>Run diagnostics</h3></div>
            <p className="dimtx" style={{ fontSize: 13 }}>Checks a line end to end: state, SIM, install status and recent activity — in plain English.</p>
            {!lines ? <div className="skel" style={{ height: 34, marginTop: 10 }} /> : lines.length === 0 ? (
              <p className="dimtx small" style={{ marginTop: 10 }}>No lines yet — diagnostics appear with your first line.</p>
            ) : (
              <>
                <div style={{ marginTop: 10 }}>
                  <ConnectSelect
                    value={pick ?? ""}
                    onChange={(v: string) => setPick(v)}
                    options={lines.map((l) => ({ value: l.id, label: l.phoneNumber ?? l.label }))}
                  />
                </div>
                <button className="lbtn primary" style={{ marginTop: 10 }} disabled={running || !pick} onClick={() => void run()}>{running ? "Checking…" : "Run check"}</button>
              </>
            )}
          </div>

          <div className="lcard">
            <div className="lcard-h"><h3>Guided fixes</h3></div>
            <div className="tl" style={{ fontSize: 13 }}>
              <div className="tlrow" style={{ padding: "5px 0" }}><span className="ti">•</span><div><span className="rowlink" onClick={() => router.push("/mobile/devices")}>eSIM won't install</span><span className="sub">Open the install screen and re-scan — most failures are a mistyped manual code</span></div></div>
              <div className="tlrow" style={{ padding: "5px 0" }}><span className="ti">•</span><div><span className="rowlink" onClick={() => void run()}>No data / no bars</span><span className="sub">Run diagnostics — it checks the carrier side for you</span></div></div>
              <div className="tlrow" style={{ padding: "5px 0" }}><span className="ti">•</span><div><span className="rowlink" onClick={() => router.push("/mobile/porting")}>My transfer is stuck</span><span className="sub">The tracker shows exactly which step and what it needs</span></div></div>
              <div className="tlrow" style={{ padding: "5px 0" }}><span className="ti">•</span><div><span className="rowlink" onClick={() => router.push("/mobile/billing")}>A charge looks wrong</span><span className="sub">Every invoice line names the line it came from</span></div></div>
            </div>
          </div>

          <div className="lcard">
            <div className="lcard-h"><h3>Lost or stolen?</h3></div>
            <p className="dimtx" style={{ fontSize: 13 }}>Stops the line instantly and keeps your number safe. Reactivate any time.</p>
            <button className="lbtn danger" style={{ marginTop: 10 }} onClick={() => router.push("/mobile/lines")}>Report a device lost</button>
          </div>
        </div>

        {diag ? (
          <div className="lcard" style={{ marginTop: 14 }}>
            <div className="lcard-h"><h3>Diagnostics — {diag.line.phoneNumber ?? diag.line.label}</h3>
              {diag.checks.some((c) => c.result === "fail") ? <span className="pill bad">Problem found</span>
                : diag.checks.some((c) => c.result === "warn") ? <span className="pill warn">1+ finding</span>
                : <span className="pill ok">All clear</span>}
            </div>
            <div className="twrap">
              <table className="t">
                <thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
                <tbody>
                  {diag.checks.map((c, i) => (
                    <tr key={i}>
                      <td>{c.check}</td>
                      <td>{c.result === "pass" ? <span className="pill ok">Pass</span> : c.result === "warn" ? <span className="pill warn">Check</span> : c.result === "fail" ? <span className="pill bad">Fail</span> : <span className="pill dim">Skipped</span>}</td>
                      <td>{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {diag.nextStep ? (
              <div className="banner info" style={{ marginTop: 12 }}>
                <div><b>{diag.nextStep.text}</b>
                  <div className="row" style={{ marginTop: 8 }}>
                    {diag.nextStep.action === "install_esim" ? <button className="lbtn sm primary" onClick={() => router.push("/mobile/devices")}>Open install screen</button> : null}
                    {diag.nextStep.action === "resume" ? <button className="lbtn sm primary" onClick={() => router.push(`/mobile/lines/${diag.line.id}`)}>Open the line</button> : null}
                  </div>
                </div>
              </div>
            ) : null}
            {diag.lastEvent ? <p className="help" style={{ marginTop: 10 }}>Last carrier event: {diag.lastEvent.eventType} · {fmtDateTime(diag.lastEvent.receivedAt)}</p> : null}
          </div>
        ) : null}

        <div className="lcard" style={{ marginTop: 14 }}>
          <div className="lcard-h"><h3>Replacements & physical SIMs</h3></div>
          <p className="dimtx" style={{ fontSize: 13 }}>New phone, replacement eSIM, or a physical SIM card: open a support request and LoopCom issues it the same day — the old profile is retired safely, and the new QR appears under Devices &amp; SIMs.</p>
          <button className="lbtn sm" style={{ marginTop: 10 }} onClick={() => router.push("/support-chat")}>Request a replacement →</button>
        </div>
      </div>
    </PermissionGate>
  );
}
