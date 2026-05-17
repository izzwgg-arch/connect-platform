"use client";

import type { CSSProperties, ElementType, ReactNode } from "react";
import { cn } from "./cn";
import { crm } from "./crmClasses";

export function CRMCard({
  children,
  className,
  padding = "lg",
  style,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  padding?: "none" | "md" | "lg";
  style?: CSSProperties;
  as?: ElementType;
}) {
  const pad = padding === "none" ? "" : padding === "md" ? crm.cardPad : crm.cardPadLg;
  return (
    <Tag className={cn(crm.card, pad, className)} style={style}>
      {children}
    </Tag>
  );
}
