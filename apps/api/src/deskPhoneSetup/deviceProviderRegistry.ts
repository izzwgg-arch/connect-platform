/**
 * Which provider handles a discovered device. The wizard asks "what did we discover?" and
 * this answers with an adapter — never the other way round.
 */
import type { Manufacturer, ProviderReadiness, SupportedManufacturer } from "@connect/shared";
import type { DeviceProvider } from "./deviceProvider";
import { resolveGdmsCredentials } from "./gdmsCredentials";
import { GrandstreamProvider } from "./grandstreamProvider";
import { FanvilDeviceProvider, PolyDeviceProvider, YealinkDeviceProvider } from "./otherDeviceProviders";

export type DeviceProviderRegistry = {
  providerFor(manufacturer: Manufacturer | string | null | undefined): DeviceProvider | null;
  all(): DeviceProvider[];
  allReadiness(): Promise<ProviderReadiness[]>;
};

export function createDeviceProviderRegistry(deps: {
  db: any;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
  overrides?: Partial<Record<SupportedManufacturer, DeviceProvider>>;
}): DeviceProviderRegistry {
  const env = deps.env ?? process.env;
  const providers: Record<SupportedManufacturer, DeviceProvider> = {
    grandstream: deps.overrides?.grandstream ?? new GrandstreamProvider({
      resolveCredentials: () => resolveGdmsCredentials(deps.db, env),
      request: deps.request,
      env,
      siteId: env.GDMS_SITE_ID || null,
    }),
    yealink: deps.overrides?.yealink ?? new YealinkDeviceProvider({ env }),
    fanvil: deps.overrides?.fanvil ?? new FanvilDeviceProvider(),
    poly: deps.overrides?.poly ?? new PolyDeviceProvider(),
  };
  const list = Object.values(providers);
  return {
    providerFor(manufacturer) {
      const key = String(manufacturer ?? "").toLowerCase() === "polycom" ? "poly" : String(manufacturer ?? "").toLowerCase();
      return (providers as Record<string, DeviceProvider>)[key] ?? null;
    },
    all: () => list,
    async allReadiness() {
      return Promise.all(list.map(async (p) => {
        try {
          return await p.readiness();
        } catch {
          return {
            manufacturer: p.manufacturer,
            platform: p.platform,
            cloudConfigured: false,
            supportedActions: [],
            claimRequiresSerial: null,
            redirectOnly: false,
            note: "This maker's device cloud couldn't be checked right now.",
          } satisfies ProviderReadiness;
        }
      }));
    },
  };
}
