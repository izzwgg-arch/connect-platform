"use client";

import { useEffect, useMemo, useState } from "react";

type ThemeMode = "dark" | "light";

export function Topbar() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  const nowLabel = useMemo(() => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), []);

  useEffect(() => {
    const saved = (localStorage.getItem("cc-theme") || "").toLowerCase();
    const next: ThemeMode = saved === "light" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cc-theme", theme);
  }, [theme]);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          type="button"
          className="top-icon nav-toggle"
          title="Toggle navigation"
          onClick={() => document.body.classList.toggle("nav-open")}
        >
          ≡
        </button>
        <div className="workspace-block">
          <strong>Connect Communications</strong>
          <span className="workspace-sub">Telecom Operations Workspace</span>
        </div>
      </div>

      <div className="topbar-search">
        <input placeholder="Search customers, extensions, invoices..." />
      </div>

      <div className="topbar-right">
        <button type="button" className="top-icon" title="Calls">📞</button>
        <button type="button" className="top-icon" title="Messages">💬</button>
        <button type="button" className="top-icon" title="Notifications" onClick={() => setStatusOpen((v) => !v)}>🔔</button>
        <button
          type="button"
          className="top-icon"
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          onClick={() => setTheme((v) => (v === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <button type="button" className="avatar" onClick={() => setMenuOpen((v) => !v)}>CC</button>
      </div>

      {statusOpen ? (
        <div className="floating-panel status-panel">
          <h4>Realtime Status</h4>
          <p>Platform: Healthy</p>
          <p>PBX: Monitoring</p>
          <p>Time: {nowLabel}</p>
        </div>
      ) : null}

      {menuOpen ? (
        <div className="floating-panel user-panel">
          <h4>Operator Menu</h4>
          <button type="button" onClick={() => setTheme((v) => (v === "dark" ? "light" : "dark"))}>Toggle Theme</button>
          <button type="button">Profile</button>
          <button type="button">Sign out</button>
        </div>
      ) : null}
    </header>
  );
}
