/**
 * runpod-endpoint.ts — payload shape tests. Injected fetch only; no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SERVERLESS_IMAGE, createEndpoint, endpointEnv, listEndpoints, setEndpointModel } from "./runpod-endpoint";

function fakeFetch(responder: (body: any) => any): typeof fetch {
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ data: responder(body) }) } as any;
  }) as any;
}

test("endpointEnv sets MODEL_NAME to the requested HF repo", () => {
  const env = endpointEnv({ name: "x", modelName: "loopcom/yi-whisper-finetuned-v1" });
  assert.deepEqual(env, [{ key: "MODEL_NAME", value: "loopcom/yi-whisper-finetuned-v1" }]);
});

test("createEndpoint uses the ivrit.ai serverless image by default and the given model", async () => {
  let sentInput: any = null;
  const fetchFn = fakeFetch((body) => {
    sentInput = body.variables.input;
    return { saveEndpoint: { id: "ep-1", name: "yc-yiddish" } };
  });
  const ep = await createEndpoint({ name: "yc-yiddish", modelName: "ivrit-ai/yi-whisper-large-v3-turbo-ct2" }, { fetchFn, apiKey: "k" });
  assert.equal(ep.id, "ep-1");
  assert.equal(sentInput.imageName, DEFAULT_SERVERLESS_IMAGE);
  assert.deepEqual(sentInput.env, [{ key: "MODEL_NAME", value: "ivrit-ai/yi-whisper-large-v3-turbo-ct2" }]);
  assert.equal(sentInput.workersMin, 0, "scales to zero when idle");
});

test("setEndpointModel targets an existing endpoint id and never re-creates it", async () => {
  let sentInput: any = null;
  const fetchFn = fakeFetch((body) => {
    sentInput = body.variables.input;
    return { saveEndpoint: { id: "ep-1", name: "yc-yiddish" } };
  });
  await setEndpointModel("ep-1", "loopcom/yi-whisper-finetuned-v1", { fetchFn, apiKey: "k" });
  assert.equal(sentInput.endpointId, "ep-1");
  assert.equal(sentInput.env[0].value, "loopcom/yi-whisper-finetuned-v1");
  assert.equal(sentInput.name, undefined, "must not send a new name — this updates in place");
});

test("listEndpoints reads myself.endpoints", async () => {
  const fetchFn = fakeFetch(() => ({ myself: { endpoints: [{ id: "ep-1", name: "yc-yiddish" }] } }));
  const eps = await listEndpoints({ fetchFn, apiKey: "k" });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].id, "ep-1");
});

test("this module has no delete/terminate-endpoint capability at all (source check)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src: string = fs.readFileSync(path.join(__dirname, "runpod-endpoint.ts"), "utf8");
  assert.doesNotMatch(src, /deleteEndpoint|endpointDelete|removeEndpoint/i);
  assert.match(src, /Never deletes an endpoint/);
});
