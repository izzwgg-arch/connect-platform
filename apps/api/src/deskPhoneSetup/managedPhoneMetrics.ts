import { Counter, Histogram, type Registry } from "prom-client";
// Bounded labels only. No tenant/MAC/URL/credential labels.
export const managedPhoneOperations = new Counter({ name: "loopcom_managed_phone_operations_total",
  help: "Managed phone operation outcomes", labelNames: ["operation", "result"], registers: [] });
export const managedPhoneDuration = new Histogram({ name: "loopcom_managed_phone_duration_seconds",
  help: "Managed phone operation duration", labelNames: ["operation"], registers: [], buckets: [0.05, 0.2, 1, 5, 15, 60] });
export function registerManagedPhoneMetrics(registry: Registry) {
  registry.registerMetric(managedPhoneOperations); registry.registerMetric(managedPhoneDuration);
}
