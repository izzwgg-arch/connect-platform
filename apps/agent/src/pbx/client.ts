/**
 * Adapter: wrap the real @connect/integrations VitalPbxClient behind the tiny
 * PbxClientLike interface the executor needs. In simulate mode the underlying
 * client short-circuits every request (no PBX contact). For live mode the
 * factory builds a client with allowConfigMutations:true FOR THAT CALL ONLY.
 *
 * PBX_ALLOW_CONFIG_MUTATIONS is never read or set here.
 */
import type { PbxClientLike } from "./executor";

export function makePbxClientFactory(cfgBase: { baseUrl?: string; apiToken?: string }) {
  return function makeClient(opts: { simulate: boolean; allowConfigMutations: boolean }): PbxClientLike {
    return {
      async callEndpointRaw(input) {
        // Lazy import so the agent boots without @connect/integrations present.
        const mod: any = await import("@connect/integrations");
        const client = new mod.VitalPbxClient({
          baseUrl: cfgBase.baseUrl,
          apiToken: cfgBase.apiToken,
          simulate: opts.simulate,
          allowConfigMutations: opts.allowConfigMutations,
        });
        // Prefer a generic raw dispatcher if present; else fall back to fetch-like.
        if (typeof client.rawRequest === "function") {
          return client.rawRequest(input.method, input.path, { tenant: input.tenant, body: input.body });
        }
        if (typeof client.callEndpointRaw === "function") {
          return client.callEndpointRaw(input);
        }
        throw new Error("VitalPbxClient has no raw dispatch method available for the executor");
      },
    };
  };
}
