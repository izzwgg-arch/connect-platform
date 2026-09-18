"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Switch, useToast } from "@/components/ui";

const LEVELS = ["PUBLIC", "CONNECTIONS", "ORGANIZATION", "PRIVATE"] as const;
const LABELS: Record<string, string> = {
  headline: "Headline & photo", about: "About & services", experience: "Experience", education: "Education", skills: "Skills", services: "Services",
  phone: "Phone number", email: "Email", connections: "Connections list", activity: "Activity & posts", location: "Location", languages: "Languages",
  links: "Links", portfolio: "Portfolio", certifications: "Certifications",
};

export default function PrivacyPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ settings: Record<string, string>; categories: string[] }>("/me/privacy").then((r) => {
      setSettings(r.settings);
      setCategories(r.categories);
    });
    api<{ prefs: Record<string, boolean> }>("/me/profile/preferences").then((r) => setPrefs(r.prefs)).catch(() => {});
  }, []);
  async function save() {
    setBusy(true);
    try {
      await api("/me/privacy", { method: "PUT", body: settings });
      await api("/me/profile/preferences", { method: "PUT", body: prefs });
      toast("Privacy settings saved.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }
  const pref = (key: string, label: string, help?: string) => (
    <div className="li" style={{ alignItems: "center" }} key={key}>
      <div className="t">
        <b style={{ fontWeight: 500 }}>{label}</b>
        {help ? <small>{help}</small> : null}
      </div>
      <Switch on={prefs[key] ?? true} label={label} onChange={(v) => setPrefs({ ...prefs, [key]: v })} />
    </div>
  );
  return (
    <>
      <div className="card">
        <div className="ct">Who can see each part of your profile</div>
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr><th>Section</th><th>Public</th><th>Connections</th><th>My company</th><th>Only me</th></tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c}>
                  <td>{LABELS[c] ?? c}</td>
                  {LEVELS.map((l) => (
                    <td key={l}>
                      <input type="radio" name={`pv-${c}`} checked={settings[c] === l} onChange={() => setSettings({ ...settings, [c]: l })} aria-label={`${LABELS[c] ?? c}: ${l.toLowerCase()}`} style={{ accentColor: "var(--accent)" }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="ct">Discovery &amp; communication</div>
        <div className="list sm">
          {pref("searchEngineVisible", "Show up in search engines", "Your public profile can be indexed by Google.")}
          {pref("findableByPhone", "Findable by phone number", "People who already have your number can find you.")}
          {pref("readReceipts", "Share read receipts", "Others see when you have read their messages — and you see theirs.")}
          {pref("showOnline", "Show when I am online")}
          {pref("messageRequests", "Allow message requests from anyone", "Off = only connections can message you.")}
          {pref("analytics", "Product analytics", "Helps us improve. Never sold, never used to infer sensitive traits.")}
        </div>
      </div>
      <div className="row">
        <Button kind="p" onClick={save} loading={busy} data-testid="privacy-save">Save changes</Button>
      </div>
    </>
  );
}
