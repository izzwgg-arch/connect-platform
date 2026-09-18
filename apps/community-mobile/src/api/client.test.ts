import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApiClient, serializeRefresh } from "./apiCore";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("a 401 with a refresh token available refreshes once and retries the request", async () => {
  let accessToken = "expired";
  const refreshToken = "refresh-1";
  let refreshCalls = 0;
  const calls: string[] = [];

  const fetchImpl = (async (url: any) => {
    calls.push(String(url));
    if (String(url).endsWith("/protected")) {
      if (accessToken === "expired") return jsonResponse(401, { error: "expired_token", message: "Token expired" });
      return jsonResponse(200, { ok: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const doRefresh = async () => {
    refreshCalls++;
    accessToken = "fresh";
    return true;
  };

  const client = createApiClient({
    baseUrl: "https://api.test",
    fetchImpl,
    getAccessToken: () => accessToken,
    getRefreshToken: () => refreshToken,
    doRefresh,
    onUnauthorized: () => {},
  });

  const result = await client.request<{ ok: boolean }>("/protected");
  assert.equal(result.ok, true);
  assert.equal(refreshCalls, 1);
  assert.equal(calls.length, 2, "should call /protected, refresh, then /protected again");
});

test("a 401 with no refresh token available calls onUnauthorized and throws ApiError once, without refreshing", async () => {
  let unauthorizedCalls = 0;
  const fetchImpl = (async () => jsonResponse(401, { error: "no_token", message: "Sign in again." })) as typeof fetch;

  const client = createApiClient({
    baseUrl: "https://api.test",
    fetchImpl,
    getAccessToken: () => null,
    getRefreshToken: () => null,
    doRefresh: async () => {
      throw new Error("doRefresh should never be called with no refresh token");
    },
    onUnauthorized: () => {
      unauthorizedCalls++;
    },
  });

  await assert.rejects(() => client.request("/whoami"), ApiError);
  assert.equal(unauthorizedCalls, 1);
});

test("a non-401 error surfaces the api's own code and human message as ApiError", async () => {
  const fetchImpl = (async () => jsonResponse(400, { error: "bad_input", message: "That phone number doesn't look right." })) as typeof fetch;
  const client = createApiClient({
    baseUrl: "https://api.test",
    fetchImpl,
    getAccessToken: () => "tok",
    getRefreshToken: () => "rt",
    doRefresh: async () => true,
    onUnauthorized: () => {},
  });
  await assert.rejects(
    () => client.request("/auth/register"),
    (err: unknown) => err instanceof ApiError && err.code === "bad_input" && err.message === "That phone number doesn't look right.",
  );
});

test("serializeRefresh: N concurrent callers trigger exactly one underlying refresh call", async () => {
  let underlyingCalls = 0;
  let resolveUnderlying!: (v: boolean) => void;
  const underlying = () =>
    new Promise<boolean>((resolve) => {
      underlyingCalls++;
      resolveUnderlying = resolve;
    });
  const refresh = serializeRefresh(underlying);

  const p1 = refresh();
  const p2 = refresh();
  const p3 = refresh();
  assert.equal(underlyingCalls, 1, "three concurrent calls should share one in-flight refresh");

  resolveUnderlying(true);
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.deepEqual([r1, r2, r3], [true, true, true]);
});

test("serializeRefresh: a later call after the in-flight one settles starts a fresh refresh", async () => {
  let underlyingCalls = 0;
  const refresh = serializeRefresh(async () => {
    underlyingCalls++;
    return true;
  });
  await refresh();
  // Allow the internal setTimeout(0) release to run before the next call.
  await new Promise((r) => setTimeout(r, 10));
  await refresh();
  assert.equal(underlyingCalls, 2);
});
