DONE

# Outreach (brief section 6): status on improve/outreach

Tend now plans follow-ups, drafts them from cited evidence and holds every one for Adam's approval. The fictional lane runs end to end with a mock Gmail and the mock Telegram; the private lane is prepared code behind `OUTREACH_ENABLED=false` and needs Adam's Google re-consent before it can create a real Gmail draft. Nothing in this branch can send a message.

## What is on the branch

| Commit           | Change                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------- |
| e0c4c91          | Cherry-pick of workflow 21 (error handler) from improve/lead                              |
| f7dc919          | Planner rules, approval book, fictional Telegram commands, fixture API routes, mock Gmail |
| f822a13, eddc239 | Rule, expiry, recipient, kill-switch and Gmail-boundary tests                             |
| e683b6c          | Outreach workflows from `src/outreach-workflows.ts` (renumbered 23-26 later)              |
| e6a8ddc          | Private routes behind internal auth, live boot wiring, HTTP tests for both lanes          |

New files: `src/outreach.ts` (pure rules), `src/outreach-store.ts` (`OutreachBook`: items and send ledger in its own SQLite file), `src/outreach-gmail.ts` (compose scope, drafts.create URL, MIME builder, `MockGmail`), `src/outreach-service.ts` (Desk backend, fixture factory, fixture and private routes), `src/outreach-workflows.ts`, `tests/outreach.test.ts`, `tests/outreach-workflows.test.ts`, `tests/outreach-api.test.ts`.

Workflows (22 is improve/lead's private error handler): 23 planner (fictional, hourly, Paris), 24 approved email to mock Gmail drafts (fictional), 25 planner (private template), 26 approved email to Gmail drafts.create (private template, `gmail.compose` credential placeholder). 23 and 24 use error workflow 21. 25 and 26 save no execution data and use error workflow `TendPrivate22`. Canvas-note text for all four IDs is exported as `outreachCanvasNotes` from `src/outreach-workflows.ts` for `withCanvasNote()`. n8n can plan, save drafts and record receipts; it has no route to approve, edit or skip. That applies to the private API (18768). The fictional fixture API (18767) does expose `/api/outreach/approve|edit|skip` without auth so the demo and integration can approve; its only Gmail is the mock, which accepts `@example.invalid` recipients only.

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

Shared files touched, each with a small hook: `src/engine.ts` (`StoreOptions.commandExtension`, 6 lines), `src/server.ts` (fixture book, mock Gmail, two route hooks; live boot creates `createPrivateOutreach`), `src/live-api.ts` (`outreach` option, two route hooks), `src/telegram.ts` (fictional guard and help add `/outreach /approve /edit /skip`, two render lines; the live guard and help strip them again), `src/build-workflows.ts` (writes 23-26, count), `src/integration.ts` (import count 25 here, 26 after merge), `tests/workflows.test.ts` (count 25 here, 26 after merge), `AGENTS.md` (twenty-five here, twenty-six after merge). Workflows 10 and 14 regenerate with the render lines.

Error phrases: `safeOutreachError` in `src/desk-api.ts` (improve/desk-ui, c2c8981) passes through only these messages thrown by `src/outreach.ts` and `src/outreach-store.ts`: unknown outreach item; cannot approve|edit|skip a <status> item; recipient is not a verified identity of this contact; empty draft; draft too long; dash not allowed; instruction-like draft; fill in the bracketed placeholder first; draft is no longer replaceable. `uncited detail: ...` is mapped to a fixed sentence. Renaming any of them means updating that list. Approved items show Edit (back to pending) and "Withdraw approval" (calls skip, so the item ends as `skipped` and the same item is not proposed again for 3 days), matching Telegram `/edit` and `/skip`.

To wire the Desk: `createPrivateOutreach()` returns `{ service, route }`; widen `LiveServerOptions.outreach` to that type and pass `options.outreach?.service` as `outreach` to `createPrivateWebHandler` in `live-api.ts`.

Integration: `src/integration.ts` now has an outreach step after the owner-command checks. It confirms the open fictional promises, runs workflow 23 in the isolated n8n, then sends `/outreach`, `/edit` and `/approve` through the native Telegram trigger. Workflow 24 then creates the mock Gmail draft, `/skip` follows, and a rerun of 23 must propose nothing new. It asserts that the injection fixture never appears. The CLI runs of 23 and 24 use `N8N_RUNNERS_BROKER_PORT=5681`, because the webhook server started for the Telegram check already holds 5679. The fixture server gets its own `TEND_OUTREACH_DB`, and the n8n start wait is 60 s instead of 18 s, because other agents' containers slowed it past the old limit.

Demo: `node --experimental-strip-types src/outreach-demo.ts serve` (fictional only, ports 18831 and 18832, refuses the live ports). It starts the real fixture API with a fresh ledger and a Desk preview whose Outreach queue calls that same API. `plan`, `telegram "<command>"`, `gmail` and `status` drive it with the exact code-node source of workflows 23 and 24 and the real Telegram reply formatter. Chrome note: the extension's navigation arrives as `Sec-Fetch-Site: cross-site`, which the private workspace rejects. Open any same-origin URL first (for example `/api/none`), then go to `/private` from that page.

## Checks run (22 Oct, 10:30 to 11:20)

- `VERIFY_FULL=1 .agents/verify.sh` on fe1bbd4: typecheck, lint, exports, format, n8n runtime (18 checks), native cited AI, native generated draft and SQL schema all pass. Unit tests: 1,262 passed. The only failures are `private-postgres` and `semantic-postgres`, where `initdb` reports "could not create shared memory segment: Operation not permitted" inside the sandbox; this is the same as the baseline.
- After the fast-forward to improve/lead and the fixes: the fast gate gives 1,310 unit tests passing, with the same two sandbox failures; typecheck, lint, exports (26) and format pass. Outreach tests: 34 in `tests/outreach.test.ts`, plus the workflow and HTTP files.
- Real model, fictional data: qwen3:0.6b echoed Mira's quote back as a draft (also seen by tend-verify as F1). Fixed in 3e2f0b0. In the rerun, the echo was rejected live ("model repeated the cited message") and three invented dates were rejected, so all four templates were kept.
- Chrome walk-through on the demo Desk, fictional only. Approving a draft that still had a placeholder was refused ("Not changed: fill in the bracketed placeholder first."). Edited and approved it in the Desk. Through the Telegram path: `/edit` with a URL refused with its reason, `/edit` then `/approve`, workflow-24 step, `/skip`, and `/approve` on the skipped item refused. The Desk then showed both emails as "Gmail draft created" with the exact approved text, LinkedIn as Skipped, and WhatsApp approved with Copy text and an "Open WhatsApp business" link. The replan created 0 drafts; `g-injection` stayed in held_back throughout. The mock Gmail held exactly 2 drafts, both to mira@example.invalid. Screenshot: `.scratch/screens/outreach/desk-outreach-queue-after-flow.jpg`.
- `bun run integration` with the outreach step: pass, 22 checks (`evidence/runtime-checks.json`, "Outreach planner, Telegram approval and mock Gmail draft"); workflows 23 and 24 ended with n8n status `success`. Two earlier attempts failed before or at the outreach step, for harness reasons fixed in this commit: the 18 s n8n start wait under host load, and the task-broker port clash.
- Verifier findings F1, F2, F6 and F10 are fixed (3e2f0b0, aef8216); tend-verify re-verified them on the merged stack. F11 (copied style-example dates) is mitigated in bb70be4 and bf2e826, and tend-verify confirmed 8 of 8 rejections with no uncited-date cases.

## Model-size limit (decision for Adam)

With qwen3:0.6b, almost every model draft is rejected: it echoes the cited message, the style example or the purpose instruction, or it invents a date. The owner therefore sees the safe templates or their own edits, never an unchecked model draft. To get real "in your style" drafts, use a larger local model for workflow 23 (for example a 3-4B instruct model in Ollama). That is a resource and setup choice, so it is left to you. The checks stay as they are.

## Pending, and what Adam must do

1. Live Telegram outreach commands: `PostgresStore.command` has its own executor, so the private bot does not route `/outreach` yet. It needs the same `commandExtension` hook (async) in `postgres-store.ts`.
2. Google re-consent for real Gmail drafts (after 14:00, Adam only):
   1. In Google Cloud console, OAuth consent screen for the Tend project, add the scope `https://www.googleapis.com/auth/gmail.compose`. Do not add `gmail.send`.
   2. In n8n, create a new Gmail OAuth2 credential named for compose. Before signing in, switch on "Define custom scopes" and replace the whole "Enabled Scopes" field with exactly `https://www.googleapis.com/auth/gmail.compose`. Left off, n8n requests its six default Gmail scopes, including `https://mail.google.com/` (full mailbox, which can send and delete). Then sign in as the owner and accept the consent screen yourself; it must list only drafting and sending email, not reading or deleting it.
   3. Import workflow 26, bind that credential to "Create Gmail draft (drafts.create only)" and the Header Auth credential to the three private API nodes. Leave it inactive.
   4. Only after approving the exact draft in chat: set `OUTREACH_ENABLED=true` for the private API, restart it, run workflow 26 once manually, confirm the draft in Gmail, then set it back to `false`.
3. The brief's "show one real draft for one real contact" step needs the running private API and real data, so it waits for the lead after 14:00.
4. `liveSnapshotOf` loads every contact, promise and interaction on each Desk `list()`/`approve()`. Fine for the prepared lane; give it a bounded query before setting `OUTREACH_ENABLED=true` on real history.
5. Postgres storage for outreach: items and the ledger live in `.scratch/live-private/outreach.sqlite` (gitignored), not the canonical PostgreSQL store.
