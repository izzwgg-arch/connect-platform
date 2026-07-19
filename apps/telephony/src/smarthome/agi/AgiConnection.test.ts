import test from "node:test";
import assert from "node:assert/strict";
import { parseAgiEnv, parseAgiResponse } from "./AgiConnection";

test("parseAgiResponse parses plain result", () => {
  assert.deepEqual(parseAgiResponse("200 result=0"), { code: 200, result: "0", extra: null });
});

test("parseAgiResponse parses digits result with extra", () => {
  assert.deepEqual(parseAgiResponse("200 result=1234 (timeout)"), {
    code: 200,
    result: "1234",
    extra: "timeout",
  });
});

test("parseAgiResponse parses negative result", () => {
  assert.deepEqual(parseAgiResponse("200 result=-1"), { code: 200, result: "-1", extra: null });
});

test("parseAgiResponse rejects garbage", () => {
  assert.equal(parseAgiResponse("HANGUP"), null);
  assert.equal(parseAgiResponse(""), null);
});

test("parseAgiEnv extracts agi_ headers only", () => {
  const env = parseAgiEnv(
    "agi_network: yes\nagi_request: agi://10.0.0.1\nagi_callerid: 15551234567\nnot_a_header\nfoo: bar",
  );
  assert.deepEqual(env, {
    agi_network: "yes",
    agi_request: "agi://10.0.0.1",
    agi_callerid: "15551234567",
  });
});
