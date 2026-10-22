DONE

# Outreach (brief section 6): status on improve/outreach

Tend now plans follow-ups, drafts them from cited evidence and holds every one for Adam's approval. The fictional lane runs end to end with a mock Gmail and the mock Telegram; the private lane is prepared code behind `OUTREACH_ENABLED=false` and needs Adam's Google re-consent before it can create a real Gmail draft. Nothing in this branch can send a message.

## What is on the branch

| Commit           | Change                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| e0c4c91          | Cherry-pick of workflow 21 (error handler) from improve/lead                              |
| f7dc919          | Planner rules, approval book, fictional Telegram commands, fixture API routes, mock Gmail |
| f822a13, eddc239 | Rule, expiry, recipient, kill-switch and Gmail-boundary tests                             |
| e683b6c          | Workflows 22-25 from `src/outreach-workflows.ts`                                          |
| e6a8ddc          | Private routes behind internal auth, live boot wiring, HTTP tests for both lanes          |

New files: `src/outreach.ts` (pure rules), `src/outreach-store.ts` (`OutreachBook`: items and send ledger in its own SQLite file), `src/outreach-gmail.ts` (compose scope, drafts.create URL, MIME builder, `MockGmail`), `src/outreach-service.ts` (Desk backend, fixture factory, fixture and private routes), `src/outreach-workflows.ts`, `tests/outreach.test.ts`, `tests/outreach-workflows.test.ts`, `tests/outreach-api.test.ts`.

Workflows: 22 planner (fictional, hourly, Paris), 23 approved email to mock Gmail drafts (fictional), 24 planner (private template), 25 approved email to Gmail drafts.create (private template, `gmail.compose` credential placeholder). 22 and 23 use error workflow 21. 24 and 25 save no execution data. n8n can plan, save drafts and record receipts; it has no route to approve, edit or skip. That applies to the private API (18768). The fictional fixture API (18767) does expose `/api/outreach/approve|edit|skip` without auth so the demo and integration can approve; its only Gmail is the mock, which accepts `@example.invalid` recipients only.

## Rules as built

- Reasons: `overdue_owed_to_you` (confirmed, owed to Adam, due before today Paris), `you_owe_soon` (confirmed, owed by Adam, due within 2 days or overdue), `after_meeting` (calendar event ended in the last 48 h), `reply_waiting` (last message in a thread is a direct received message 1 h to 14 days old, not the evidence of a promise).
- Quiet hours 21:00-08:00 Europe/Paris via `Intl` (tested across the 25 Oct clock change). Rate limit: one proposal per item key every 3 days.
- Instruction-like messages (the `g-injection` fixture) go to `held_back` and are never drafted. Drafts with any URL, email, phone number or date that is not verbatim in the cited evidence, an em/en dash, or instruction-like text are rejected; a rejected model draft keeps the template. Bracketed placeholders block approval.
- Style: the owner's own sent messages to that contact are passed as style examples (`style_basis: recipient_examples`), else `default`; an owner edit becomes `owner_edit`.
- Approval binds the exact text hash. It expires 24 h after approval, or immediately when cited evidence changes or the promise behind it is no longer confirmed. Any edit returns the item to `pending`. Pending items expire after 3 days.
- Recipients are only the contact's stored identities for that channel (never the OWNER identity); re-checked at approval and again before the Gmail step. The fictional lane additionally accepts only `@example.invalid`.
- Sending: email only, as a Gmail draft that Adam sends from Gmail. WhatsApp and LinkedIn items get a `deep_link` (wa.me with prefilled text, or the LinkedIn profile) once approved; the Desk copies the text.
- Kill switch: `OUTREACH_ENABLED` must equal `true` on the private API before `approved-email` returns anything or a Gmail receipt is accepted. The fictional lane is always on because its only Gmail is the mock.

## API contract (for improve/desk-ui and improve/lead)

`OutreachService` (`src/outreach-service.ts`) structurally matches `DeskOutreachBackend`: `list()`, `approve(id)`, `edit(id, text)`, `skip(id)`; it throws to reject. Items follow the shared contract and add two optional fields, `recipient` and `deep_link` (string or null). `createFixtureOutreachService()` gives an in-memory Mira Tan (F17) backend with five pending drafts for Desk tests and demos.

## Merge notes for improve/lead

Shared files touched, each with a small hook: `src/engine.ts` (`StoreOptions.commandExtension`, 6 lines), `src/server.ts` (fixture book, mock Gmail, two route hooks; live boot creates `createPrivateOutreach`), `src/live-api.ts` (`outreach` option, two route hooks), `src/telegram.ts` (fictional guard and help add `/outreach /approve /edit /skip`, two render lines; the live guard and help strip them again), `src/build-workflows.ts` (writes 22-25, count), `src/integration.ts` (import count 25), `tests/workflows.test.ts` (count 25), `AGENTS.md` (twenty-five). Workflows 10 and 14 regenerate with the render lines.

Error phrases: `safeOutreachError` in `src/desk-api.ts` (improve/desk-ui, c2c8981) passes through only these messages thrown by `src/outreach.ts` and `src/outreach-store.ts`: unknown outreach item; cannot approve|edit|skip a <status> item; recipient is not a verified identity of this contact; empty draft; draft too long; dash not allowed; instruction-like draft; fill in the bracketed placeholder first; draft is no longer replaceable. `uncited detail: ...` is mapped to a fixed sentence. Renaming any of them means updating that list. The Desk offers Approve, Edit and Skip only on pending items; the book also allows edit and skip on approved items, which Telegram `/edit` and `/skip` use to withdraw an approval.

To wire the Desk: `createPrivateOutreach()` returns `{ service, route }`; widen `LiveServerOptions.outreach` to that type and pass `options.outreach?.service` as `outreach` to `createPrivateWebHandler` in `live-api.ts`.

Integration (section 7, lead's): import 25 workflows; run 22 then 23 with the fixture API; the path is already proven node by node in `tests/outreach-api.test.ts`. Set `TEND_OUTREACH_CLOCK` to pin the fixture outreach clock (default `2026-10-17T07:00:00Z`, 09:00 Paris) and `TEND_OUTREACH_DB` for an isolated ledger.

## Checks run (22 Oct, about 10:00)

- `bun run typecheck`, `bun run lint`, `bun run build` (25 exports), `bun run format:check`: pass.
- `bun run test`: 1,261 passed, 16 skipped; 2 files fail at `initdb` inside the sandbox (`private-postgres`, `semantic-postgres`), the same environment failure as the recorded baseline. Outreach tests: 29 across three files, including a spawned fixture server on a local port.
- Not run: `bun run integration` (Docker n8n) and anything against the running n8n or private API, per the demo guard.

## Pending, and what Adam must do

1. Live Telegram outreach commands: `PostgresStore.command` has its own executor, so the private bot does not route `/outreach` yet. It needs the same `commandExtension` hook (async) in `postgres-store.ts`.
2. Google re-consent for real Gmail drafts (after 14:00, Adam only):
   1. In Google Cloud console, OAuth consent screen for the Tend project, add the scope `https://www.googleapis.com/auth/gmail.compose`. Do not add `gmail.send`.
   2. In n8n, create a new Gmail OAuth2 credential named for compose, sign in as the owner and accept the consent screen yourself.
   3. Import workflow 25, bind that credential to "Create Gmail draft (drafts.create only)" and the Header Auth credential to the three private API nodes. Leave it inactive.
   4. Only after approving the exact draft in chat: set `OUTREACH_ENABLED=true` for the private API, restart it, run workflow 25 once manually, confirm the draft in Gmail, then set it back to `false`.
3. The brief's "show one real draft for one real contact" step needs the running private API and real data, so it waits for the lead after 14:00.
4. `liveSnapshotOf` loads every contact, promise and interaction on each Desk `list()`/`approve()`. Fine for the prepared lane; give it a bounded query before setting `OUTREACH_ENABLED=true` on real history.
5. Postgres storage for outreach: items and the ledger live in `.scratch/live-private/outreach.sqlite` (gitignored), not the canonical PostgreSQL store.
