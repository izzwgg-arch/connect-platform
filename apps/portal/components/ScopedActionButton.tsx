"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ScopeActionGuard } from "./ScopeActionGuard";

type ScopedActionButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
  children: ReactNode;
  allowInGlobal?: boolean;
  disabledTitle?: string;
  title?: string;
};

export function ScopedActionButton({
  children,
  allowInGlobal,
  disabledTitle,
  title,
  disabled,
  ...rest
}: ScopedActionButtonProps) {
  return (
    <ScopeActionGuard allowInGlobal={allowInGlobal} disabledTitle={disabledTitle}>
      {({ disabled: scopeDisabled, title: scopeTitle }) => (
        <button {...rest} disabled={Boolean(disabled) || scopeDisabled} title={scopeTitle || title}>
          {children}
        </button>
      )}
    </ScopeActionGuard>
  );
}
