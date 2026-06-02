"use client";

import { useState } from "react";
import {
  parseQuantityDraft,
  quantityToDraft,
  sanitizeQuantityDraft,
} from "../../lib/billingMoneyInput";

type Props = {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
  min?: number;
  max?: number;
};

export function BillingQuantityInput({
  value,
  onChange,
  disabled = false,
  className,
  testId,
  min = 0,
  max = 100_000,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");

  const displayValue = disabled ? String(value) : focused ? draft : String(value);

  return (
    <input
      type="text"
      inputMode="numeric"
      className={className}
      data-testid={testId}
      disabled={disabled}
      value={displayValue}
      onFocus={() => {
        if (disabled) return;
        setDraft(quantityToDraft(value));
        setFocused(true);
      }}
      onBlur={() => {
        if (disabled) return;
        setFocused(false);
        onChange(parseQuantityDraft(draft, 0));
      }}
      onChange={(event) => {
        if (disabled) return;
        const next = sanitizeQuantityDraft(event.target.value);
        setDraft(next);
        if (next !== "") {
          onChange(parseQuantityDraft(next, value));
        }
      }}
      min={min}
      max={max}
    />
  );
}
