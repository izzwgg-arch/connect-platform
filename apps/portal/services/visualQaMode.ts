const VISUAL_QA_STORAGE_KEY = "cc-crm-visual-qa";

function base64UrlEncode(value: string): string {
  const encoded =
    typeof window !== "undefined"
      ? window.btoa(value)
      : Buffer.from(value, "utf-8").toString("base64");
  return encoded.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isVisualQaModeEnabled(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (process.env.NEXT_PUBLIC_CRM_VISUAL_QA !== "1") return false;
  if (typeof window === "undefined") return false;
  return isLoopbackHost(window.location.hostname);
}

export function createVisualQaToken(): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: "visual-qa-user",
      tenantId: "visual-qa-tenant",
      role: "SUPER_ADMIN",
      email: "visual-qa@connect.local",
      name: "CRM Visual QA",
      iat: 1,
    }),
  );
  return `${header}.${payload}.local-dev-only`;
}

export function bootstrapVisualQaSession(): void {
  if (!isVisualQaModeEnabled()) return;
  const token = createVisualQaToken();
  localStorage.setItem("token", token);
  localStorage.setItem("cc-token", token);
  localStorage.setItem("authToken", token);
  localStorage.setItem("cc-tenant-id", "visual-qa-tenant");
  localStorage.setItem("cc-admin-scope", "TENANT");
  localStorage.setItem(VISUAL_QA_STORAGE_KEY, "1");
}

