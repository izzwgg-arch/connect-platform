"use client";

/**
 * Desk phones found on a customer's own network.
 *
 * ⛔ THE POINT OF THIS SCREEN is the comparison nobody could make before: what
 * the PBX record says a phone's MAC is, versus what it actually is. When those
 * differ, VitalPBX rewrites a config file no handset ever downloads — the panel
 * looks correct, the log shows a clean 200 for a different filename, and the
 * phone serves a config from weeks ago with no error anywhere.
 *
 * ⛔ An empty list is NEVER rendered as "this office has no phones". The three
 * facts that make an empty list readable — has anyone ever scanned, when, and
 * which network — are shown every time.
 */
import { useCallback, useEffect, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { desktopBridge, isDesktopShell } from "../../../../services/remoteSupport";

type Phone = {
  id: string;
  mac: string | null;
  ip: string | null;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  provisioningUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

type Run = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  note: string | null;
  subnet: string | null;
  deviceLabel: string | null;
  hostsSeen: number;
  phonesFound: number;
};

type Inventory = {
  phones: Phone[];
  everScanned: boolean;
  scanCount: number;
  lastRun: Run | null;
};

export default function LanPhonesPage() {
  return (
    <PermissionGate
      permission={"can_view_lan_phones" as any}
      fallback={
        <div className="card" style={{ margin: 24, padding: 24 }}>
          <h2>Phones on the network</h2>
          <p>You do not have permission to view the phone inventory.</p>
        </div>
      }
    >
      <LanPhonesConsole />
    </PermissionGate>
  );
}

function LanPhonesConsole() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setInventory(await apiGet<Inventory>("/lan-phones"));
    } catch {
      setError("The phone list could not be loaded.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * Scanning only works from the Windows app, because it has to be ON the
   * customer's network to see anything. Said plainly rather than showing a
   * button that cannot work.
   */
  const scan = useCallback(async () => {
    const bridge = desktopBridge();
    if (!bridge?.lanScan?.run) {
      setError("Scanning only works in the Connect desktop app, on a computer in that office.");
      return;
    }

    setScanning(true);
    setError(null);
    setMessage(null);
    try {
      const machine = await bridge.remoteSupport?.machineInfo?.().catch(() => null);
      const subnets: string[] = await bridge.lanScan.subnets().catch(() => []);

      const run = await apiPost<{ run: Run }>("/lan-phones/runs", {
        deviceLabel: machine ? `${machine.hostname} (app ${machine.appVersion})` : undefined,
        subnet: subnets[0],
      } as any);

      const result = await bridge.lanScan.run();

      const reported = await apiPost<{ stored: number; rejected: number }>(
        `/lan-phones/runs/${run.run.id}/report`,
        {
          outcome: result.outcome,
          note: result.note,
          hostsSeen: result.hostsSeen,
          phones: (result.hosts || []).map((h: any) => ({
            macAddress: h.mac,
            ipAddress: h.ip,
          })),
        } as any,
      );

      setMessage(
        result.outcome === "failed"
          ? result.note || "The scan could not run."
          : `Looked at ${result.subnet ?? "this network"} and found ${reported.stored} device${reported.stored === 1 ? "" : "s"}.`,
      );
      await load();
    } catch {
      setError("The scan could not be completed.");
    } finally {
      setScanning(false);
    }
  }, [load]);

  const phones = inventory?.phones ?? [];
  const knownPhones = phones.filter((p) => p.vendor);
  const otherDevices = phones.filter((p) => !p.vendor);

  return (
    <div className="lp-page">
      <header className="lp-head">
        <h1>Phones on the network</h1>
        <button type="button" className="btn btn-primary" onClick={() => void scan()} disabled={scanning}>
          {scanning ? "Looking…" : "Scan this network"}
        </button>
      </header>

      {!isDesktopShell() && (
        <p className="rs-note">
          To scan, open this page in the Connect desktop app on a computer in that office. This page
          still shows whatever was found last time.
        </p>
      )}

      {message && <p className="rs-status">{message}</p>}
      {error && <p className="rs-error" role="alert">{error}</p>}

      {/* ⛔ The three facts that stop an empty list reading as "no phones here". */}
      <section className="card lp-summary">
        {!inventory ? (
          <p>Loading…</p>
        ) : !inventory.everScanned ? (
          <p><strong>Nobody has scanned this office yet.</strong> That is why this list is empty — it does not mean there are no phones.</p>
        ) : (
          <p>
            Last looked{" "}
            {inventory.lastRun?.startedAt ? new Date(inventory.lastRun.startedAt).toLocaleString() : "at an unknown time"}
            {inventory.lastRun?.subnet ? ` at ${inventory.lastRun.subnet}` : ""}
            {inventory.lastRun?.deviceLabel ? `, from ${inventory.lastRun.deviceLabel}` : ""}.{" "}
            {inventory.scanCount} scan{inventory.scanCount === 1 ? "" : "s"} in total.
            {inventory.lastRun?.note ? ` ${inventory.lastRun.note}` : ""}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Desk phones ({knownPhones.length})</h2>
        {knownPhones.length === 0 ? (
          <p>No desk phones recognised on this network.</p>
        ) : (
          <table className="rs-table">
            <thead>
              <tr><th>Make</th><th>Address on the network</th><th>Hardware ID (MAC)</th><th>Model</th><th>Last seen</th></tr>
            </thead>
            <tbody>
              {knownPhones.map((p) => (
                <tr key={p.id}>
                  <td>{p.vendor}</td>
                  <td>{p.ip || "—"}</td>
                  {/* Monospace so a wrong character is actually spottable. */}
                  <td style={{ fontFamily: "ui-monospace, monospace" }}>{p.mac || "—"}</td>
                  <td>{p.model || "—"}</td>
                  <td>{new Date(p.lastSeenAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {otherDevices.length > 0 && (
        <section className="card">
          <h2>Other devices ({otherDevices.length})</h2>
          <p className="rs-note">
            Computers, printers and anything else on the same network. Listed for completeness — these
            are not phones.
          </p>
          <table className="rs-table">
            <thead><tr><th>Address</th><th>Hardware ID (MAC)</th><th>Last seen</th></tr></thead>
            <tbody>
              {otherDevices.map((p) => (
                <tr key={p.id}>
                  <td>{p.ip || "—"}</td>
                  <td style={{ fontFamily: "ui-monospace, monospace" }}>{p.mac || "—"}</td>
                  <td>{new Date(p.lastSeenAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
