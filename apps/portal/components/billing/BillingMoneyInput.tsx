"use client";

import { useState } from "react";
import {
  centsToMoneyDraft,
  formatCentsAsDollars,
  parseDollarsInput,
  sanitizeMoneyDraft,
} from "../../lib/billingMoneyInput";

type Props = {
  cents: number;
  onCentsChange: (cents: number) => void;
  readOnly?: boolean;
  disabled?: boolean;
  className?: string;
  testId?: string;
};

export function BillingMoneyInput({
  cents,
  onCentsChange,
  readOnly = false,
  disabled = false,
  className,
  testId,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");

  const locked = readOnly || disabled;
  const displayValue = focused ? draft : formatCentsAsDollars(cents);

  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      data-testid={testId}
      readOnly={readOnly}
      disabled={disabled}
      value={displayValue}
      onFocus={() => {
        if (locked) return;
        setDraft(centsToMoneyDraft(cents));
        setFocused(true);
      }}
      onBlur={() => {
        if (locked) return;
        setFocused(false);
        onCentsChange(parseDollarsInput(draft));
      }}
      onChange={(event) => {
        if (locked) return;
        setDraft(sanitizeMoneyDraft(event.target.value));
      }}
    />
  );
}
