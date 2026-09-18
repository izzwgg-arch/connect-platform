"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Switch, useToast } from "@/components/ui";

type ClassRow = { kind: string; label: string; inApp: boolean; push: boolean; email: boolean; sms: boolean; canSms: boolean };
type QuietHours = { enabled: boolean; from: string; to: string; days: number[] };

const DAYS = [
  { n: 0, label: "Sun" },
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
];

export default function NotificationSettingsPage() {
  const toast = useToast();
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [quiet, setQuiet] = useState<QuietHours>({ enabled: false, from: "16:00", to: "21:00", days: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ classes: ClassRow[]; quietHours: QuietHours }>("/me/notification-prefs")
      .then((r) => {
        setClasses(r.classes);
        setQuiet(r.quietHours);
      })
      .finally(() => setLoading(false));
  }, []);

  function setCell(kind: string, channel: "inApp" | "push" | "email" | "sms", v: boolean) {
    setClasses((cur) => cur.map((c) => (c.kind === kind ? { ...c, [channel]: v } : c)));
  }

  function toggleDay(n: number) {
    setQuiet((q) => ({ ...q, days: q.days.includes(n) ? q.days.filter((d) => d !== n) : [...q.days, n].sort() }));
  }

  async function save() {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        classes: Object.fromEntries(classes.map((c) => [c.kind, { inApp: c.inApp, push: c.push, email: c.email, sms: c.sms }])),
        quietHours: quiet,
      };
      await api("/me/notification-prefs", { method: "PUT", body: payload });
      const fresh = await api<{ classes: ClassRow[]; quietHours: QuietHours }>("/me/notification-prefs");
      setClasses(fresh.classes);
      setQuiet(fresh.quietHours);
      toast("Notification settings saved.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="card"><div className="skel" style={{ height: 200 }} /></div>;

  return (
    <>
      <div className="card">
        <div className="ct">Notify me by class</div>
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Type</th>
                <th>In-app</th>
                <th>Push</th>
                <th>Email</th>
                <th>SMS</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c.kind} data-testid={`notifsettings-row-${c.kind}`}>
                  <td>{c.label}</td>
                  <td>
                    <Switch id={`inApp-${c.kind}`} on={c.inApp} label={`${c.label}: in-app`} onChange={(v) => setCell(c.kind, "inApp", v)} />
                  </td>
                  <td>
                    <Switch id={`push-${c.kind}`} on={c.push} label={`${c.label}: push`} onChange={(v) => setCell(c.kind, "push", v)} />
                  </td>
                  <td>
                    <Switch id={`email-${c.kind}`} on={c.email} label={`${c.label}: email`} onChange={(v) => setCell(c.kind, "email", v)} />
                  </td>
                  <td>
                    {c.canSms ? (
                      <Switch id={`sms-${c.kind}`} on={c.sms} label={`${c.label}: SMS`} onChange={(v) => setCell(c.kind, "sms", v)} />
                    ) : (
                      <span className="dim xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sm dim" style={{ marginTop: 8 }}>
          SMS is only available for security alerts, and only once your mobile number is verified (Settings → Account).
        </p>
      </div>

      <div className="card">
        <div className="ct">Quiet hours</div>
        <div className="li" style={{ alignItems: "center" }}>
          <div className="t">
            <b style={{ fontWeight: 500 }}>Silence push during quiet hours</b>
            <small>In-app notifications still arrive; push is held until quiet hours end.</small>
          </div>
          <Switch on={quiet.enabled} label="Enable quiet hours" onChange={(v) => setQuiet((q) => ({ ...q, enabled: v }))} id="quiet-enabled" />
        </div>
        {quiet.enabled ? (
          <div className="grid3" style={{ marginTop: 10 }}>
            <div className="field">
              <label className="lbl" htmlFor="quiet-from">From</label>
              <input id="quiet-from" className="in" type="time" value={quiet.from} onChange={(e) => setQuiet((q) => ({ ...q, from: e.target.value }))} data-testid="notifsettings-quiet-from" />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="quiet-to">To</label>
              <input id="quiet-to" className="in" type="time" value={quiet.to} onChange={(e) => setQuiet((q) => ({ ...q, to: e.target.value }))} data-testid="notifsettings-quiet-to" />
            </div>
            <div className="field">
              <span className="lbl">Days</span>
              <div className="pill-row">
                {DAYS.map((d) => (
                  <button
                    key={d.n}
                    type="button"
                    className={`chip ${quiet.days.includes(d.n) ? "sel" : ""}`}
                    onClick={() => toggleDay(d.n)}
                    data-testid={`notifsettings-quiet-day-${d.n}`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="row">
        <Button kind="p" onClick={save} loading={busy} data-testid="notifsettings-save">
          Save changes
        </Button>
      </div>
    </>
  );
}
