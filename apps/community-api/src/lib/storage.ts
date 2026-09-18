import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { env } from "../env.js";

/** Local disk in dev, S3 when COMMUNITY_S3_BUCKET is set. Keys never contain user input. */
export interface Storage {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

class DiskStorage implements Storage {
  constructor(private root: string) {}
  private p(key: string) {
    const safe = key.replace(/[^a-zA-Z0-9/_.-]/g, "_");
    const full = path.resolve(this.root, safe);
    if (!full.startsWith(path.resolve(this.root))) throw new Error("bad storage key");
    return full;
  }
  async put(key: string, bytes: Buffer) {
    const full = this.p(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }
  async get(key: string) {
    return readFile(this.p(key));
  }
  async remove(key: string) {
    try {
      await unlink(this.p(key));
    } catch {
      /* already gone */
    }
  }
  async exists(key: string) {
    return existsSync(this.p(key));
  }
}

class S3Storage implements Storage {
  private client: any;
  constructor(private bucket: string) {}
  private async c() {
    if (!this.client) {
      const { S3Client } = await import("@aws-sdk/client-s3");
      this.client = new S3Client({
        region: env().COMMUNITY_S3_REGION || "us-east-1",
        endpoint: env().COMMUNITY_S3_ENDPOINT || undefined,
        forcePathStyle: !!env().COMMUNITY_S3_ENDPOINT,
      });
    }
    return this.client;
  }
  async put(key: string, bytes: Buffer, mime: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.c()).send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mime }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const out = await (await this.c()).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await out.Body.transformToByteArray());
  }
  async remove(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.c()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async exists(key: string) {
    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      await (await this.c()).send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

let instance: Storage | null = null;
export function storage(): Storage {
  if (!instance) {
    const e = env();
    instance = e.COMMUNITY_S3_BUCKET ? new S3Storage(e.COMMUNITY_S3_BUCKET) : new DiskStorage(e.COMMUNITY_STORAGE_DIR);
  }
  return instance;
}
