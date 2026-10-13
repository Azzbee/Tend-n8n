import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./engine.ts";

export function verificationHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
export class InternalAuth {
  private hash: string | null;
  private readonly path: string | undefined;
  readonly setupNonce = randomBytes(32).toString("hex");
  constructor(path?: string, hash?: string) {
    this.path = path;
    this.hash = hash ?? null;
    if (path && existsSync(path)) {
      if ((statSync(path).mode & 0o077) !== 0)
        throw new Error("private auth hash file permissions required");
      const data: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        !isRecord(data) ||
        Object.keys(data).length !== 1 ||
        typeof data.api_key_sha256 !== "string"
      )
        throw new Error("invalid auth hash file");
      this.hash = data.api_key_sha256;
    }
    if (this.hash !== null && !/^[0-9a-f]{64}$/.test(this.hash))
      throw new Error("invalid verification hash");
  }
  ready(): boolean {
    return this.hash !== null;
  }
  verify(header: string | undefined): boolean {
    if (!this.hash || !header?.startsWith("Bearer ")) return false;
    const supplied = verificationHash(header.slice(7));
    return timingSafeEqual(
      Buffer.from(supplied, "hex"),
      Buffer.from(this.hash, "hex"),
    );
  }
  configure(secret: string, nonce: string): void {
    if (
      this.ready() ||
      nonce.length !== this.setupNonce.length ||
      !timingSafeEqual(Buffer.from(nonce), Buffer.from(this.setupNonce))
    )
      throw new Error("setup rejected");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret) || new Set(secret).size < 16)
      throw new Error("random 32-byte base64url key required");
    const hash = verificationHash(secret);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.path,
        JSON.stringify({ api_key_sha256: hash }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    }
    this.hash = hash;
  }
}
