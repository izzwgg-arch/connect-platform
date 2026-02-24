declare function require(name: string): any;
declare const process: any;
declare const Buffer: any;

const crypto: any = require("crypto");

const CREDENTIAL_KEY_ENV = "CREDENTIALS_MASTER_KEY";
const KEY_ID = "v1";

type Envelope = {
  iv: string;
  tag: string;
  ciphertext: string;
  keyId: string;
};

function getMasterKey() {
  const raw = process.env[CREDENTIAL_KEY_ENV];
  if (!raw) {
    throw new Error(`${CREDENTIAL_KEY_ENV} is required for credential encryption`);
  }
  const normalized = String(raw).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${CREDENTIAL_KEY_ENV} must be a 64-char hex string`);
  }
  return Buffer.from(normalized, "hex");
}

export function hasCredentialsMasterKey(): boolean {
  const raw = process.env[CREDENTIAL_KEY_ENV];
  return !!raw && /^[0-9a-fA-F]{64}$/.test(String(raw).trim());
}

export function encryptJson(value: unknown): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: Envelope = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    keyId: KEY_ID
  };

  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export function decryptJson<T = any>(encoded: string): T {
  const key = getMasterKey();
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const envelope = JSON.parse(decoded) as Envelope;

  if (!envelope.iv || !envelope.tag || !envelope.ciphertext) {
    throw new Error("Malformed encrypted payload");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");

  return JSON.parse(plaintext) as T;
}
