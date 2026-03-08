"use client";

import { useState } from "react";
import { SearchInput } from "./SearchInput";

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  return (
    <div className="global-search">
      <SearchInput value={query} onChange={setQuery} placeholder="Search contacts, numbers, extensions, invoices..." />
    </div>
  );
}
