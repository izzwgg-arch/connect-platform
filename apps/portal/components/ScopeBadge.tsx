export function ScopeBadge({ scope }: { scope: "GLOBAL" | "TENANT" }) {
  return <span className={`scope-badge ${scope.toLowerCase()}`}>{scope === "GLOBAL" ? "Global Scope" : "Tenant Scope"}</span>;
}
