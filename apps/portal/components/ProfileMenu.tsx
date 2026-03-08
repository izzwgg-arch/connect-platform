"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAppContext } from "../hooks/useAppContext";
import { clearAuthSession } from "../services/session";
import { ScopedActionButton } from "./ScopedActionButton";
import { ThemeToggle } from "./ThemeToggle";

export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { user, tenant, role, setRole } = useAppContext();

  function logout() {
    clearAuthSession();
    router.replace("/login");
  }

  return (
    <div className="menu-wrap">
      <button className="icon-btn profile-trigger" onClick={() => setOpen((v) => !v)} title={user.name}>
        {user.name
          .split(" ")
          .map((part) => part[0])
          .join("")
          .slice(0, 2)
          .toUpperCase()}
      </button>
      {open ? (
        <div className="dropdown-panel">
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
        </div>
      ) : null}
    </div>
  );
}
