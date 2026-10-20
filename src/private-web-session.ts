import { randomBytes, timingSafeEqual } from "node:crypto";
export interface PrivateSession {
  key: string;
  csrf: string;
  expires_at: string;
}
interface Preauth {
  key: string;
  nonce: string;
  expires: number;
}
const token = (): string => randomBytes(32).toString("base64url");
const equal = (a: string, b: string): boolean => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export class PrivateWebSessions {
  private readonly pending = new Map<string, Preauth>();
  private readonly sessions = new Map<string, PrivateSession>();
  private readonly clock: () => Date;
  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }
  private purge(): void {
    const now = this.clock().getTime();
    for (const [k, p] of this.pending)
      if (p.expires <= now) this.pending.delete(k);
    for (const [k, s] of this.sessions)
      if (Date.parse(s.expires_at) <= now) this.sessions.delete(k);
  }
  preauth(): Preauth {
    this.purge();
    if (this.pending.size >= 100) throw new Error("Too many unlock attempts");
    const p = {
      key: token(),
      nonce: token(),
      expires: this.clock().getTime() + 5 * 60000,
    };
    this.pending.set(p.key, p);
    return p;
  }
  unlock(key: string, nonce: string): PrivateSession | null {
    this.purge();
    const p = this.pending.get(key);
    if (!p || !equal(p.nonce, nonce)) return null;
    this.pending.delete(key);
    if (this.sessions.size >= 10) return null;
    const s = {
      key: token(),
      csrf: token(),
      expires_at: new Date(this.clock().getTime() + 30 * 60000).toISOString(),
    };
    this.sessions.set(s.key, s);
    return s;
  }
  get(key: string): PrivateSession | null {
    this.purge();
    return this.sessions.get(key) ?? null;
  }
  lock(key: string): void {
    this.sessions.delete(key);
  }
}
