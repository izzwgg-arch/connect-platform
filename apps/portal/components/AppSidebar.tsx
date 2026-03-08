"use client";

import { navItems } from "../navigation/navConfig";
import { useAppContext } from "../hooks/useAppContext";
import { SidebarNavGroup } from "./SidebarNavGroup";

export function AppSidebar() {
  const { can } = useAppContext();
  const visible = navItems.filter((item) => can(item.permission));

  return (
    <aside className="sidebar">
      <div className="brand">CC</div>
      <SidebarNavGroup label="Workspace" items={visible.slice(0, 8)} />
      <SidebarNavGroup label="Admin & Tools" items={visible.slice(8)} />
    </aside>
  );
}
