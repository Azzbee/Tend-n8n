// Gmail is reached only through users.drafts.create: the owner presses Send
// in Gmail. gmail.compose technically also allows sending, so the exports and
// tests pin the single permitted endpoint; gmail.send is never requested.
export const GMAIL_COMPOSE_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_DRAFTS_CREATE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
export const MOCK_GMAIL_DRAFTS_PATH =
  "/api/mock-gmail/gmail/v1/users/me/drafts";

const safeHeader = /^[^\r\n]{1,200}$/;
export function buildRawMessage(
  to: string,
  subject: string,
  body: string,
): string {
  if (!safeHeader.test(to) || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(to))
    throw new Error("invalid recipient");
  if (!safeHeader.test(subject)) throw new Error("invalid subject");
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}
export function decodeRawMessage(raw: string): {
  to: string;
  subject: string;
  body: string;
} {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("invalid MIME message");
  const header = (name: string): string =>
    text
      .slice(0, split)
      .split("\r\n")
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2) ?? "";
  return {
    to: header("To"),
    subject: header("Subject"),
    body: text.slice(split + 4),
  };
}
// Fictional-lane stand-in for Gmail. It accepts only drafts.create and only
// example.invalid recipients, and keeps drafts in memory for the demo.
export class MockGmail {
  readonly drafts: { id: string; to: string; subject: string; body: string }[] =
    [];
  handle(
    method: string,
    path: string,
    input: unknown,
  ): { status: number; body: Record<string, unknown> } {
    if (method !== "POST" || path !== MOCK_GMAIL_DRAFTS_PATH)
      return {
        status: 404,
        body: {
          error: "mock Gmail supports drafts.create only",
          fictional: true,
        },
      };
    const raw =
      typeof input === "object" &&
      input !== null &&
      typeof (input as { message?: { raw?: unknown } }).message?.raw ===
        "string"
        ? (input as { message: { raw: string } }).message.raw
        : null;
    if (!raw) return { status: 400, body: { error: "message.raw required" } };
    const message = decodeRawMessage(raw);
    if (!/^[^\s@]+@example\.invalid$/.test(message.to))
      return {
        status: 400,
        body: { error: "fictional recipients only", fictional: true },
      };
    const id = `r-mock-${this.drafts.length + 1}`;
    this.drafts.push({ id, ...message });
    return {
      status: 200,
      body: {
        id,
        message: { id: `m-mock-${this.drafts.length}`, threadId: `t-${id}` },
        fictional: true,
      },
    };
  }
}
