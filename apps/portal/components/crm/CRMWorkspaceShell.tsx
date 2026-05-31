"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";
import { crm } from "./crmClasses";

/** Root — fills the CRM page inner area and disables page-level scroll via globals.css. */
export function CRMWorkspaceShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(crm.workspaceShell, className)}>{children}</div>;
}

/** Fixed chrome stack: header, KPIs, filters, controls (flex-shrink-0). */
export function CRMWorkspaceChrome({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(crm.workspaceChrome, className)}>{children}</div>;
}

export function CRMWorkspaceHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(crm.workspaceHeader, className)}>{children}</div>;
}

export function CRMWorkspaceToolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(crm.workspaceToolbar, className)}>{children}</div>;
}

/** Main body — optional right rail via `split`. */
export function CRMWorkspaceBody({
  children,
  className,
  split = false,
}: {
  children: ReactNode;
  className?: string;
  split?: boolean;
}) {
  return (
    <div className={cn(crm.workspaceBody, split && crm.workspaceBodySplit, className)}>
      {children}
    </div>
  );
}

/** Primary column wrapper when using a split body layout. */
export function CRMWorkspaceMain({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(crm.workspaceMain, className)}>{children}</div>;
}

export function CRMWorkspaceContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(crm.workspaceContent, className)}>{children}</div>;
}

/** Independent vertical scroll for lists, tables, and library panels. */
export function CRMWorkspaceScrollRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(crm.workspaceScrollRegion, className)}>{children}</div>;
}

/** Right-side summary rail — stays visible; inner region scrolls when tall. */
export function CRMWorkspaceRightRail({
  children,
  className,
  scrollClassName,
}: {
  children: ReactNode;
  className?: string;
  scrollClassName?: string;
}) {
  return (
    <aside className={cn(crm.workspaceRightRail, className)}>
      <div className={cn(crm.workspaceRightRailScroll, scrollClassName)}>{children}</div>
    </aside>
  );
}

export function CRMWorkspaceFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(crm.workspaceFooter, className)}>{children}</div>;
}
