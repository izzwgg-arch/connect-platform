"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppContext } from "../hooks/useAppContext";
import { clearAuthSession } from "../services/session";
import { ScopedActionButton } from "./ScopedActionButton";
import { ThemeToggle } from "./ThemeToggle";
import { ViewportDropdown } from "./ViewportDropdown";

export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const router = useRouter();
  const { user, tenant, role, setRole } = useAppContext();
  const closeMenu = useCallback(() => setOpen(false), []);
  const displayName = formatTopbarUserName(user.name, user.email);
  const avatarText = initialsFor(displayName);

  function logout() {
    clearAuthSession();
    router.replace("/login");
  }

  return (
    <div className="menu-wrap">
      <button ref={triggerRef} className="icon-btn profile-trigger" onClick={() => setOpen((v) => !v)} title={displayName}>
        <span className="profile-trigger-avatar" aria-hidden>{avatarText}</span>
        <span className="profile-trigger-name">{displayName}</span>
      </button>
      <ViewportDropdown open={open} triggerRef={triggerRef} onClose={closeMenu} width={280}>
          <div className="panel-headline">{tenant.name}</div>
          <div className="meta">{user.email}</div>
          <div className="meta">Ext {user.extension}</div>
          <div className="meta">Role: {role}</div>
          <div className="menu-actions">
            <ThemeToggle />
            <select className="select" value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
              <option value="END_USER">End User</option>
              <option value="TENANT_ADMIN">Tenant Admin</option>
              <option value="SUPER_ADMIN">Super Admin</option>
            </select>
            <ScopedActionButton className="btn">Set DND</ScopedActionButton>
            <ScopedActionButton className="btn ghost">Office Hours Override</ScopedActionButton>
            <button className="btn danger" onClick={logout}>Logout</button>
          </div>
      </ViewportDropdown>
    </div>
  );
}

function formatTopbarUserName(name?: string | null, email?: string | null): string {
  const rawName = (name ?? "").trim();
  const rawEmail = (email ?? "").trim();
  const base = rawName && !rawName.includes("@")
    ? rawName
    : rawEmail.split("@")[0] || rawName.split("@")[0] || "User";
  return base.replace(/\d{6,}$/, "") || base;
}

function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "U";
}
