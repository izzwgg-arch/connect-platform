import test from "node:test";
import assert from "node:assert/strict";
import { resolveBillingGatewayConfig } from "./solaGateway";

type FakeRow = {
  tenantId: string;
  isEnabled: boolean;
  mode: "TEST" | "PROD";
  simulate: boolean;
  apiBaseUrl: string;
  authMode?: "XKEY_BODY" | "AUTHORIZATION_HEADER";
  authHeaderName?: string | null;
  credentialsEncrypted: string;
  pathOverrides?: Record<string, string> | null;
  updatedAt?: Date;
  tenantHasSuperAdmin?: boolean;
};

function fakeDb(rows: FakeRow[], ifieldsKey: string | null = null) {
  const sorted = [...rows].sort((a, b) => (b.updatedAt?.getTime() || 0) - (a.updatedAt?.getTime() || 0));
  return {
    globalSolaConfig: {
      async findUnique() {
        return { id: "default", ifieldsKey };
      },
    },
    billingSolaConfig: {
      async findUnique(args: any) {
        const tenantId = String(args?.where?.tenantId || "");
        return sorted.find((row) => row.tenantId === tenantId) || null;
      },
      async findFirst(args: any) {
        const needsSuper = !!args?.where?.tenant?.users?.some?.role;
        if (needsSuper) {
          return sorted.find((row) => row.isEnabled && row.tenantHasSuperAdmin) || null;
        }
        return sorted.find((row) => row.isEnabled) || null;
      },
    },
  };
}

function decodeSecrets(encrypted: string) {
  if (encrypted.startsWith("valid:")) {
    const suffix = encrypted.slice("valid:".length);
    return { apiKey: `api-${suffix}`, ifieldsKey: `ifields-${suffix}` };
  }
  throw new Error("bad credentials");
}

test("uses tenant override first when valid and enabled", async () => {
  const dbClient = fakeDb([
    {
      tenantId: "tenant-a",
      isEnabled: true,
      mode: "PROD",
      simulate: false,
      apiBaseUrl: "https://tenant.example",
      credentialsEncrypted: "valid:tenant",
      updatedAt: new Date("2026-05-20T10:00:00.000Z"),
    },
    {
      tenantId: "main",
      isEnabled: true,
      mode: "TEST",
      simulate: true,
      apiBaseUrl: "https://main.example",
      credentialsEncrypted: "valid:main",
      tenantHasSuperAdmin: true,
      updatedAt: new Date("2026-05-19T10:00:00.000Z"),
    },
  ]);
  const resolved = await resolveBillingGatewayConfig("tenant-a", { dbClient, decodeSecrets });
  assert.equal(resolved.source, "tenant");
  assert.equal(resolved.configured, true);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.tenantOverridePresent, true);
});

test("disabled tenant row falls through to enabled main tenant config", async () => {
  const dbClient = fakeDb([
    {
      tenantId: "tenant-a",
      isEnabled: false,
      mode: "PROD",
      simulate: false,
      apiBaseUrl: "https://tenant.example",
      credentialsEncrypted: "valid:tenant",
      updatedAt: new Date("2026-05-20T10:00:00.000Z"),
    },
    {
      tenantId: "main",
      isEnabled: true,
      mode: "TEST",
      simulate: true,
      apiBaseUrl: "https://main.example",
      credentialsEncrypted: "valid:main",
      tenantHasSuperAdmin: true,
      updatedAt: new Date("2026-05-19T10:00:00.000Z"),
    },
  ]);
  const resolved = await resolveBillingGatewayConfig("tenant-a", { dbClient, decodeSecrets });
  assert.equal(resolved.source, "main_tenant");
  assert.equal(resolved.configured, true);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.tenantOverridePresent, true);
});

test("invalid tenant credentials do not block inheritance", async () => {
  const dbClient = fakeDb([
    {
      tenantId: "tenant-a",
      isEnabled: true,
      mode: "PROD",
      simulate: false,
      apiBaseUrl: "https://tenant.example",
      credentialsEncrypted: "invalid",
      updatedAt: new Date("2026-05-20T10:00:00.000Z"),
    },
    {
      tenantId: "main",
      isEnabled: true,
      mode: "TEST",
      simulate: false,
      apiBaseUrl: "https://main.example",
      credentialsEncrypted: "valid:main",
      tenantHasSuperAdmin: true,
      updatedAt: new Date("2026-05-19T10:00:00.000Z"),
    },
  ]);
  const resolved = await resolveBillingGatewayConfig("tenant-a", { dbClient, decodeSecrets });
  assert.equal(resolved.source, "main_tenant");
  assert.equal(resolved.configured, true);
});

test("falls back to env/global when tenant and main are unavailable", async () => {
  const oldBase = process.env.SOLA_CARDKNOX_API_BASE_URL;
  const oldKey = process.env.SOLA_CARDKNOX_API_KEY;
  const oldIfields = process.env.SOLA_CARDKNOX_IFIELDS_KEY;
  const oldAllowEnvFallback = process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK;
  process.env.SOLA_CARDKNOX_API_BASE_URL = "https://env.example";
  process.env.SOLA_CARDKNOX_API_KEY = "env-key";
  process.env.SOLA_CARDKNOX_IFIELDS_KEY = "env-ifields";
  process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK = "1";
  try {
    const resolved = await resolveBillingGatewayConfig("tenant-a", { dbClient: fakeDb([]), decodeSecrets });
    assert.equal(resolved.source, "global");
    assert.equal(resolved.configured, true);
    assert.equal(resolved.ifieldsKey, "env-ifields");
  } finally {
    process.env.SOLA_CARDKNOX_API_BASE_URL = oldBase;
    process.env.SOLA_CARDKNOX_API_KEY = oldKey;
    process.env.SOLA_CARDKNOX_IFIELDS_KEY = oldIfields;
    process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK = oldAllowEnvFallback;
  }
});

test("does not use customer tenant configs as main fallback when BILLING_MAIN_TENANT_ID is set", async () => {
  const oldMainTenantId = process.env.BILLING_MAIN_TENANT_ID;
  const oldPlatformTenantId = process.env.PLATFORM_TENANT_ID;
  const oldAllowEnvFallback = process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK;
  process.env.BILLING_MAIN_TENANT_ID = "platform-main";
  delete process.env.PLATFORM_TENANT_ID;
  process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK = "1";
  try {
    const dbClient = fakeDb([
      {
        tenantId: "customer-a",
        isEnabled: true,
        mode: "PROD",
        simulate: false,
        apiBaseUrl: "https://customer-a.example",
        credentialsEncrypted: "valid:customer-a",
        tenantHasSuperAdmin: true,
        updatedAt: new Date("2026-05-20T10:00:00.000Z"),
      },
      {
        tenantId: "customer-b",
        isEnabled: true,
        mode: "PROD",
        simulate: false,
        apiBaseUrl: "https://customer-b.example",
        credentialsEncrypted: "valid:customer-b",
        updatedAt: new Date("2026-05-21T10:00:00.000Z"),
      },
    ]);
    const resolved = await resolveBillingGatewayConfig("tenant-without-local-config", { dbClient, decodeSecrets });
    assert.equal(resolved.source, "missing");
    assert.equal(resolved.configured, false);
    assert.equal(resolved.adapter, null);
  } finally {
    process.env.BILLING_MAIN_TENANT_ID = oldMainTenantId;
    process.env.PLATFORM_TENANT_ID = oldPlatformTenantId;
    process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK = oldAllowEnvFallback;
  }
});

test("returns missing when no tenant, main, or env config exists", async () => {
  const oldBase = process.env.SOLA_CARDKNOX_API_BASE_URL;
  const oldKey = process.env.SOLA_CARDKNOX_API_KEY;
  const oldAllowEnvFallback = process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK;
  delete process.env.SOLA_CARDKNOX_API_BASE_URL;
  delete process.env.SOLA_CARDKNOX_API_KEY;
  delete process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK;
  try {
    const resolved = await resolveBillingGatewayConfig("tenant-a", { dbClient: fakeDb([], "global-ifields"), decodeSecrets });
    assert.equal(resolved.source, "missing");
    assert.equal(resolved.configured, false);
    assert.equal(resolved.ifieldsKey, "global-ifields");
  } finally {
    process.env.SOLA_CARDKNOX_API_BASE_URL = oldBase;
    process.env.SOLA_CARDKNOX_API_KEY = oldKey;
    process.env.BILLING_GATEWAY_ALLOW_ENV_FALLBACK = oldAllowEnvFallback;
  }
});
