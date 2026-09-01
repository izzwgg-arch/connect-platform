"use client";

/**
 * The switch for a bad day (mandate Phase 30).
 *
 * ⛔ DESIGN RULES, all of them deliberate:
 *
 *  1. One screen, usable during a security incident, by somebody who is not
 *     calm. No tabs, no wizard, no confirmation that hides what it is about to
 *     do behind a word like "proceed".
 *
 *  2. Every destructive control says the NUMBER it is about to affect before it
 *     is pressed, and the number it actually affected afterwards. "Done" is not
 *     an answer during an incident.
 *
 *  3. Switching remote support off ENDS what is running. The copy says so, and
 *     the server does so in the same request — a kill switch that only closes
 *     the door has left whoever is already inside still watching.
 *
 *  4. ⛔ The screen never decides anything. Every button posts to a route that
 *     re-checks SUPER_ADMIN in its own handler. Hiding a button is presentation;
 *     it is not access, and this file must never be the only thing standing
 *     between somebody and the switch.
 */
import { useCallback, useEffect, useState } from "react";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { PermissionGate } from "../../../../../components/PermissionGate";
import {
  addRevocation,
  getControls,
  setControls,
  terminateSessions,
  type RemoteSupportControls,
} from "../../../../../services/remoteSupport";

/** Live sessions move; a stale screen during an incident is worse than none. */
const REFRESH_MS = 5_000;

export default function RemoteSupportControlsPage() {
  return (
    <PermissionGate permission="can_manage_global_settings">
      <ControlsScreen />
    </PermissionGate>
  );
}

function ControlsScreen() {
  const [data, setData] = useState<RemoteSupportControls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [revokeScope, setRevokeScope] = useState<"TECHNICIAN" | "DEVICE" | "TENANT">("TECHNICIAN");
  const [revokeSubject, setRevokeSubject] = useState("");
  const [revokeReason, setRevokeReason] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await getControls());
      setError(null);
    } catch (e: any) {
      // ⛔ The server's own sentence, not a slug. This screen is read under
      // pressure and "forbidden" tells nobody what to do next.
      setError(e?.body?.message || e?.message || "Could not read the remote support controls.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        setNotice(await fn());
      } catch (e: any) {
        setError(e?.body?.message || e?.message || `${label} did not work.`);
      } finally {
        setBusy(false);
        await load();
      }
    },
    [load],
  );

  const enabled = data?.controls.enabled !== false;
  const live = data?.liveSessions ?? [];

  return (
    <div className="rsc-page">
      <div className="rsc-head">
        <div>
          <h1>Remote support controls</h1>
          <p>Everything here takes effect immediately, and survives a restart.</p>
        </div>
        <a className="btn" href="/admin/remote-support">Back to sessions</a>
      </div>

      {error && <div className="rsc-alert rsc-alert--bad" role="alert">{error}</div>}
      {notice && <div className="rsc-alert rsc-alert--ok" role="status">{notice}</div>}

      {/* ── the switch ────────────────────────────────────────────── */}
      <section className={`rsc-card rsc-master${enabled ? "" : " is-off"}`}>
        <div className="rsc-master-text">
          <h2>{enabled ? "Remote support is available" : "Remote support is switched off"}</h2>
          <p>
            {enabled ? (
              <>
                Turning this off stops all new sessions platform-wide
                {live.length > 0 ? ` and ends the ${live.length} that ${live.length === 1 ? "is" : "are"} running` : ""}.
              </>
            ) : (
              <>
                No new sessions can start. {data?.controls.disabledReason
                  ? `Reason recorded: “${data.controls.disabledReason}”`
                  : "No reason was recorded."}
              </>
            )}
          </p>
          {enabled && (
            <input
              className="rsc-input"
              placeholder="Why are you switching it off? (shown to technicians)"
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </div>
        <button
          type="button"
          className={`btn ${enabled ? "btn-danger" : "btn-primary"}`}
          disabled={busy}
          onClick={() =>
            void run("Switching remote support", async () => {
              const res = await setControls({ enabled: !enabled, reason: reason.trim() || undefined });
              setReason("");
              return res.controls.enabled
                ? "Remote support is available again."
                : `Remote support is off. ${res.sessionsEnded} live session${res.sessionsEnded === 1 ? "" : "s"} ended.`;
            })
          }
        >
          {enabled ? "Switch off remote support" : "Switch it back on"}
        </button>
      </section>

      {/* ── live sessions ─────────────────────────────────────────── */}
      <section className="rsc-card rsc-card--flush">
        <div className="rsc-section-head">
          <h2>Live sessions · {live.length}</h2>
          {live.length > 0 && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() =>
                void run("Ending all sessions", async () => {
                  const res = await terminateSessions({ all: true });
                  return `${res.sessionsEnded} session${res.sessionsEnded === 1 ? "" : "s"} ended.`;
                })
              }
            >
              End all sessions
            </button>
          )}
        </div>

        {live.length === 0 ? (
          // ⛔ "Nobody is connected" and "we could not check" are different
          // things and must never render the same way on this screen.
          <p className="rsc-empty">
            {data ? "Nobody is connected to a customer's computer right now." : "Checking…"}
          </p>
        ) : (
          <div className="rsc-rows">
            {live.map((s) => (
              <div key={s.id} className="rsc-row">
                <span className={`rsc-pill ${s.status === "ACTIVE" ? "is-live" : ""}`}>
                  {s.status === "ACTIVE" ? "Live" : s.status === "CONSENTED" ? "Connecting" : "Waiting"}
                </span>
                <span className="rsc-who">
                  <b>
                    {s.requestedByName || s.requestedByUserId} → {s.targetUserName || s.targetUserId}
                  </b>
                  <span>
                    {s.controlGranted ? "control granted" : "view only"}
                    {s.capabilitiesGranted.filter((c) => c !== "view" && c !== "control").length > 0 &&
                      ` · ${s.capabilitiesGranted.filter((c) => c !== "view" && c !== "control").join(", ")}`}
                    {s.deviceLabel ? ` · ${s.deviceLabel}` : ""}
                    {s.startedAt ? ` · ${sinceLabel(s.startedAt)}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run("Ending the session", async () => {
                      const res = await terminateSessions({ sessionId: s.id });
                      return res.sessionsEnded > 0 ? "Session ended." : "That session had already finished.";
                    })
                  }
                >
                  End
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── revocations ───────────────────────────────────────────── */}
      <section className="rsc-card">
        <h2>Withdraw access</h2>
        <p className="rsc-hint">
          A block stays in place until it is lifted, and ends anything that person or machine is
          running right now.
        </p>

        <div className="rsc-revoke">
          {/*
            ⛔ ConnectSelect, never a native dropdown element. Izzy's standing
            rule since 2026-08-23: every dropdown on the platform is this one,
            present and future — `lib/nativeSelectSweep.test.ts` fails the build
            otherwise, and it caught this exact file on the first pass.

            ⛔ That guard scans SOURCE and only drops comment-shaped LINES (it
            deliberately has no block-stripper, because one opening a fake
            comment at a regex literal would turn a negative assertion into a
            false PASS). So a continuation line inside a comment like this one
            must not spell the tag out — which is why this reads "native
            dropdown element". Sixth time this trap has been hit in this repo.
          */}
          <ConnectSelect
            value={revokeScope}
            onChange={(v) => setRevokeScope(v as typeof revokeScope)}
            options={[
              { value: "TECHNICIAN", label: "A technician (user id)" },
              { value: "DEVICE", label: "A computer (device id)" },
              { value: "TENANT", label: "A whole customer (tenant id)" },
            ]}
            size="sm"
            style={{ flex: "1 1 200px" }}
          />
          <input
            className="rsc-input"
            placeholder={
              revokeScope === "TECHNICIAN" ? "User id" : revokeScope === "DEVICE" ? "Device id" : "Tenant id"
            }
            value={revokeSubject}
            onChange={(e) => setRevokeSubject(e.target.value)}
          />
          <input
            className="rsc-input"
            placeholder="Reason (optional)"
            value={revokeReason}
            maxLength={300}
            onChange={(e) => setRevokeReason(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || revokeSubject.trim().length === 0}
            onClick={() =>
              void run("Withdrawing access", async () => {
                const res = await addRevocation({
                  scope: revokeScope,
                  subjectId: revokeSubject.trim(),
                  reason: revokeReason.trim() || undefined,
                });
                setRevokeSubject("");
                setRevokeReason("");
                return `Access withdrawn. ${res.sessionsEnded} live session${res.sessionsEnded === 1 ? "" : "s"} ended.`;
              })
            }
          >
            Withdraw
          </button>
        </div>

        {(data?.revocations.length ?? 0) > 0 && (
          <div className="rsc-rows rsc-rows--tight">
            {data!.revocations.map((r) => (
              <div key={r.id} className="rsc-row">
                <span className="rsc-pill is-bad">{scopeLabel(r.scope)}</span>
                <span className="rsc-who">
                  <b>{r.subjectId}</b>
                  <span>
                    {r.reason || "No reason recorded"} · {new Date(r.createdAt).toLocaleString()}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function scopeLabel(scope: string): string {
  if (scope === "TECHNICIAN") return "Technician";
  if (scope === "DEVICE") return "Computer";
  return "Customer";
}

/** "4 min" rather than a timestamp — during an incident, elapsed is what matters. */
function sinceLabel(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
