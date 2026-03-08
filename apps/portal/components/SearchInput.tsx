"use client";

export function SearchInput({
  value,
  placeholder,
  onChange
}: {
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  return (
    <input
      className="input"
      value={value}
      placeholder={placeholder || "Search"}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
