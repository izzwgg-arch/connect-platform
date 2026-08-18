import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FORBIDDEN_SIGNING_LITERAL,
  resolveUrlSigningKey,
  urlSigningEnvVar,
  type UrlSigningScheme,
} from "./urlSigningSecret";

/**
 * Guard for the fix to §3b of AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md.
 *
 * Four signing helpers (prompt / MOH / CRM doc / CRM voicemail-drop) ended their
 * `||` chain on the literal "dev-signing-secret", which is published in this
 * repo — and `""` is falsy, so an env var "set" to blank slid past every rung
 * with no error and no log line.
 *
 * ⛔ Half 2 reads each helper's SOURCE. A unit test of the resolver passes
 * straight through a helper that still has its own private chain — the defect
 * was four CALLERS, not one function.
 */

const SCHEMES: UrlSigningScheme[] = ["prompt", "moh", "crm-doc", "crm-voicemail-drop"];

const ALL_SIGNING_VARS = [
  "PROMPT_URL_SIGNING_SECRET",
  "MOH_URL_SIGNING_SECRET",
  "CRM_DOC_URL_SIGNING_SECRET",
  "CRM_VOICEMAIL_DROP_URL_SIGNING_SECRET",
  "CDR_INGEST_SECRET",
  "JWT_SECRET",
];

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ALL_SIGNING_VARS) saved[k] = process.env[k];
  for (const k of ALL_SIGNING_VARS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of ALL_SIGNING_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── Half 1: the resolver ──────────────────────────────────────────────────────

test("⛔ resolveUrlSigningKey: THROWS rather than fall back to a literal when nothing is configured", () => {
  for (const scheme of SCHEMES) {
    withEnv({}, () => {
      assert.throws(
        () => resolveUrlSigningKey(scheme),
        /url_signing_secret_unavailable/,
        `${scheme} must refuse to sign with no key`,
      );
    });
  }
});

test("⛔ resolveUrlSigningKey: never returns the repo literal, under any env combination", () => {
  const combos: Record<string, string | undefined>[] = [
    {},
    { JWT_SECRET: "" },
    { JWT_SECRET: "   " },
    { PROMPT_URL_SIGNING_SECRET: "", MOH_URL_SIGNING_SECRET: "", JWT_SECRET: "jwt-abc" },
    { CDR_INGEST_SECRET: "an-internal-door-secret", JWT_SECRET: "jwt-abc" },
    { JWT_SECRET: "jwt-abc" },
  ];
  for (const scheme of SCHEMES) {
    for (const env of combos) {
      withEnv(env, () => {
        let key: string | null = null;
        try {
          key = resolveUrlSigningKey(scheme);
        } catch {
          return; // throwing is an acceptable outcome; returning the literal is not
        }
        assert.notEqual(key, FORBIDDEN_SIGNING_LITERAL);
        assert.ok(!key.includes(FORBIDDEN_SIGNING_LITERAL));
      });
    }
  }
});

test("⛔ resolveUrlSigningKey: an EMPTY dedicated variable does NOT slide onto a literal — it derives", () => {
  withEnv({ PROMPT_URL_SIGNING_SECRET: "", JWT_SECRET: "jwt-secret-value" }, () => {
    const key = resolveUrlSigningKey("prompt");
    const expected = crypto
      .createHmac("sha256", "jwt-secret-value")
      .update("connect:prompt-url-signing:v1")
      .digest("hex");
    assert.equal(key, expected);
  });
});

test("⛔ resolveUrlSigningKey: CDR_INGEST_SECRET is NO LONGER part of the chain", () => {
  // It is an authentication credential for the /internal/* doors. Rotating it
  // must not silently invalidate every outstanding signed URL.
  for (const scheme of SCHEMES) {
    withEnv({ CDR_INGEST_SECRET: "the-internal-door-secret" }, () => {
      assert.throws(
        () => resolveUrlSigningKey(scheme),
        /url_signing_secret_unavailable/,
        `${scheme} must not accept CDR_INGEST_SECRET as a signing key`,
      );
    });
    withEnv({ CDR_INGEST_SECRET: "the-internal-door-secret", JWT_SECRET: "jwt-abc" }, () => {
      assert.notEqual(resolveUrlSigningKey(scheme), "the-internal-door-secret");
    });
  }
});

test("resolveUrlSigningKey: an explicit dedicated variable wins", () => {
  withEnv({ MOH_URL_SIGNING_SECRET: "  explicit-moh-key  ", JWT_SECRET: "jwt-abc" }, () => {
    assert.equal(resolveUrlSigningKey("moh"), "explicit-moh-key");
  });
});

test("resolveUrlSigningKey: one scheme's variable never leaks into another's key", () => {
  withEnv({ MOH_URL_SIGNING_SECRET: "explicit-moh-key", JWT_SECRET: "jwt-abc" }, () => {
    assert.equal(resolveUrlSigningKey("moh"), "explicit-moh-key");
    for (const other of ["prompt", "crm-doc", "crm-voicemail-drop"] as UrlSigningScheme[]) {
      assert.notEqual(
        resolveUrlSigningKey(other),
        "explicit-moh-key",
        `${other} must not borrow MOH_URL_SIGNING_SECRET`,
      );
    }
  });
});

test("⛔ resolveUrlSigningKey: the four derived keys are all DIFFERENT — prompt and MOH sign identical payloads", () => {
  withEnv({ JWT_SECRET: "jwt-abc" }, () => {
    const keys = SCHEMES.map((s) => resolveUrlSigningKey(s));
    assert.equal(new Set(keys).size, SCHEMES.length, "domain separation must give each scheme its own key");
  });
});

test("⛔ resolveUrlSigningKey: the derived key is never the raw JWT_SECRET", () => {
  withEnv({ JWT_SECRET: "jwt-abc" }, () => {
    for (const scheme of SCHEMES) {
      const key = resolveUrlSigningKey(scheme);
      assert.notEqual(key, "jwt-abc");
      assert.ok(!key.includes("jwt-abc"), "a leaked signed URL must not expose the JWT signing key");
    }
  });
});

test("resolveUrlSigningKey: deterministic — the same env yields the same key every call", () => {
  withEnv({ JWT_SECRET: "jwt-abc" }, () => {
    for (const scheme of SCHEMES) {
      assert.equal(resolveUrlSigningKey(scheme), resolveUrlSigningKey(scheme));
    }
  });
});

test("resolveUrlSigningKey: read at CALL time, so a container that gains the var needs no code change", () => {
  withEnv({ JWT_SECRET: "jwt-abc" }, () => {
    const derived = resolveUrlSigningKey("crm-doc");
    process.env.CRM_DOC_URL_SIGNING_SECRET = "pinned-later";
    assert.equal(resolveUrlSigningKey("crm-doc"), "pinned-later");
    assert.notEqual(derived, "pinned-later");
  });
});

test("urlSigningEnvVar: each scheme names its own documented variable", () => {
  assert.equal(urlSigningEnvVar("prompt"), "PROMPT_URL_SIGNING_SECRET");
  assert.equal(urlSigningEnvVar("moh"), "MOH_URL_SIGNING_SECRET");
  assert.equal(urlSigningEnvVar("crm-doc"), "CRM_DOC_URL_SIGNING_SECRET");
  assert.equal(urlSigningEnvVar("crm-voicemail-drop"), "CRM_VOICEMAIL_DROP_URL_SIGNING_SECRET");
});

// ── Half 2: the four call sites (the defect was the callers) ──────────────────

const HELPERS: Array<{ file: string; scheme: UrlSigningScheme }> = [
  { file: "./promptStorage.ts", scheme: "prompt" },
  { file: "./mohStorage.ts", scheme: "moh" },
  { file: "./crmVoicemailDropStorage.ts", scheme: "crm-voicemail-drop" },
  { file: "./crm/docImportStorage.ts", scheme: "crm-doc" },
];

function readCode(relative: string): string {
  return readFileSync(resolve(__dirname, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

for (const { file, scheme } of HELPERS) {
  test(`⛔ source: ${file} carries no literal signing secret`, () => {
    const src = readCode(file);
    assert.ok(
      !src.includes(FORBIDDEN_SIGNING_LITERAL),
      `${file} must not contain the literal "${FORBIDDEN_SIGNING_LITERAL}" in executable code`,
    );
  });

  test(`⛔ source: ${file} delegates to the shared resolver for "${scheme}"`, () => {
    const src = readCode(file);
    assert.ok(
      src.includes(`resolveUrlSigningKey("${scheme}")`),
      `${file} must call resolveUrlSigningKey("${scheme}")`,
    );
  });

  test(`⛔ source: ${file} no longer borrows CDR_INGEST_SECRET as a signing key`, () => {
    const src = readCode(file);
    assert.ok(
      !src.includes("CDR_INGEST_SECRET"),
      `${file} must not read the internal-door auth secret`,
    );
  });

  test(`source: ${file} has no private || fallback chain left in signingSecret()`, () => {
    const src = readCode(file);
    const fn = /function signingSecret\(\): string \{([\s\S]*?)\n\}/.exec(src);
    assert.ok(fn, `${file} must still define signingSecret()`);
    assert.ok(
      !fn![1].includes("||"),
      `${file}'s signingSecret() must not rebuild a fallback chain`,
    );
  });
}

test("⛔ source: no helper anywhere in apps/api reintroduces the literal", () => {
  // Belt and braces across the four known helpers plus the shared resolver:
  // only urlSigningSecret.ts may mention it, and only as the forbidden constant.
  const resolverSrc = readCode("./urlSigningSecret.ts");
  const occurrences = (resolverSrc.match(new RegExp(FORBIDDEN_SIGNING_LITERAL, "g")) || []).length;
  assert.equal(
    occurrences,
    1,
    "urlSigningSecret.ts may name the literal exactly once, as FORBIDDEN_SIGNING_LITERAL",
  );
  assert.ok(
    resolverSrc.includes("export const FORBIDDEN_SIGNING_LITERAL"),
    "the single occurrence must be the exported constant",
  );
});
