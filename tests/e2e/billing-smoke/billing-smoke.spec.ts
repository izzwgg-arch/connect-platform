import { test, expect } from "@playwright/test";
import { requireEnv } from "./helpers/env";
import { loginAsSuperAdmin, primeTenantScope } from "./helpers/auth";

test.describe.configure({ mode: "serial" });

test.describe("SUPER_ADMIN billing smoke", () => {
  let tenantId: string;

  test.beforeAll(() => {
    tenantId = requireEnv("BILLING_E2E_TENANT_ID");
  });

  test.beforeEach(async ({ page }) => {
    await loginAsSuperAdmin(page);
  });

  test("admin billing settings — pricing, modals, harmless branding save", async ({ page }, testInfo) => {
    await page.goto(
      `/admin/billing/settings?tenantId=${encodeURIComponent(tenantId)}`,
      { waitUntil: "domcontentloaded" },
    );

    const tenantSelect = page.getByTestId("billing-admin-tenant-select");
    await expect(tenantSelect).toBeAttached({ timeout: 60_000 });
    await expect(tenantSelect).toHaveValue(tenantId);

    await page.getByRole("link", { name: "Taxes & invoices" }).click();
    const brandingSave = page.getByTestId("billing-admin-save-branding");
    await expect(brandingSave).toBeVisible({ timeout: 60_000 });
    if (await brandingSave.isVisible()) {
      const brandingPut = page.waitForResponse(
        (r) =>
          r.request().method() === "PUT" &&
          /\/admin\/billing\/tenants\/[^/]+\/settings\b/.test(r.url()) &&
          r.ok(),
        { timeout: 60_000 },
      );
      await brandingSave.click();
      await brandingPut;
    }

    await page.getByTestId("billing-admin-assign-plan-open").click();
    const assignDialog = page.getByTestId("billing-admin-assign-plan-dialog");
    await expect(assignDialog).toBeVisible({ timeout: 60_000 });
    await assignDialog.getByRole("button", { name: "Refresh preview" }).click({ timeout: 60_000 });
    await assignDialog.getByTestId("billing-admin-assign-plan-cancel").click();
    await expect(page.getByTestId("billing-admin-assign-plan-dialog")).toHaveCount(0);

    const resetOpen = page.getByTestId("billing-admin-reset-plan-open");
    if (await resetOpen.isDisabled()) {
      testInfo.skip(true, "Reset-to-plan unavailable — use a tenant with a linked billingPlanId.");
    }
    await resetOpen.click({ timeout: 60_000 });
    const resetDialog = page.getByTestId("billing-admin-reset-plan-dialog");
    await expect(resetDialog).toBeVisible({ timeout: 60_000 });
    await resetDialog.getByTestId("billing-admin-reset-plan-cancel").click();
    await expect(page.getByTestId("billing-admin-reset-plan-dialog")).toHaveCount(0);
  });

  test("admin billing plans — list, create modal, clone modal", async ({ page }) => {
    await page.goto("/admin/billing/plans", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("billing-admin-plans-list-card")).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("billing-admin-plans-open-create").click();
    await expect(page.getByTestId("billing-admin-plans-panel-create")).toBeVisible();
    await page.getByTestId("billing-admin-plans-create-cancel").click();
    await expect(page.getByTestId("billing-admin-plans-panel-create")).toHaveCount(0);

    const cloneBtn = page.locator('[data-testid^="billing-admin-plans-clone-"]').first();
    await expect(cloneBtn).toBeVisible({ timeout: 60_000 });
    await cloneBtn.click();
    await expect(page.getByTestId("billing-admin-plans-panel-clone")).toBeVisible();
    await page.getByTestId("billing-admin-plans-clone-cancel").click();
    await expect(page.getByTestId("billing-admin-plans-panel-clone")).toHaveCount(0);
  });

  test("admin payment operations — invoices, collections, reports routes", async ({ page }) => {
    await page.goto(`/admin/billing/invoices?tenantId=${encodeURIComponent(tenantId)}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("billing-admin-tab-panel-invoices")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".billing-inv-toolbar")).toBeVisible();

    await page.getByTestId("billing-admin-ws-nav-collections").click();
    await expect(page.getByTestId("billing-admin-tab-panel-collections")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Collections overview" })).toBeVisible();

    await page.getByTestId("billing-admin-ws-nav-reports").click();
    await expect(page.getByTestId("billing-admin-tab-panel-reports")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "CSV Exports" })).toBeVisible();

    await page.getByTestId("billing-admin-ws-nav-invoices").click();
    await expect(page.getByTestId("billing-admin-tab-panel-invoices")).toBeVisible();
  });

  test("tenant billing — overview and invoices list", async ({ page }) => {
    await primeTenantScope(page, tenantId);
    await page.goto("/billing", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("billing-tenant-overview-loaded")).toBeVisible({ timeout: 60_000 });

    await page.goto("/billing/invoices", { waitUntil: "domcontentloaded" });
    const root = page.getByTestId("billing-tenant-invoices-root");
    await expect(root).toBeVisible({ timeout: 60_000 });
    await expect(
      root.locator(".billing-invoice-row").first().or(root.getByText("No invoices yet")),
    ).toBeVisible({ timeout: 60_000 });
  });
});
