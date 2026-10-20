import { describe, expect, it } from "vitest";
import { PrivateWebSessions } from "../src/private-web-session.ts";
describe("private device sessions", () => {
  it("requires one-time bound preauth, expires absolutely and never accepts a machine bearer", () => {
    let now = 0;
    const sessions = new PrivateWebSessions(() => new Date(now));
    const pre = sessions.preauth();
    expect(sessions.unlock("wrong", pre.nonce)).toBeNull();
    const session = sessions.unlock(pre.key, pre.nonce)!;
    expect(session).not.toBeNull();
    expect(sessions.unlock(pre.key, pre.nonce)).toBeNull();
    expect(sessions.get("Bearer test")).toBeNull();
    expect(sessions.get(session.key)).toEqual(session);
    now = 30 * 60 * 1000;
    expect(sessions.get(session.key)).toBeNull();
  });
  it("caps contexts and invalidates logout", () => {
    const sessions = new PrivateWebSessions(() => new Date(0));
    for (let n = 0; n < 100; n++) sessions.preauth();
    expect(() => sessions.preauth()).toThrow();
    const other = new PrivateWebSessions();
    const pre = other.preauth();
    const s = other.unlock(pre.key, pre.nonce)!;
    other.lock(s.key);
    expect(other.get(s.key)).toBeNull();
  });
});
