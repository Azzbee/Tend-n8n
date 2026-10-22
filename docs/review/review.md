# Independent review of improve/lead (stand-in for the Codex cross-vendor review)

Reviewer: Claude, branch `review/codex`. Codex is out of quota until 27 Oct, so this replaces `/codex:review`.
Reviewed: `git diff master...HEAD` after merging `improve/lead` at `05f7050` (73 files, +8731/-236), 22 Oct 2026 10:33 Paris.
Not touched: the live n8n on 5678, the private API on 18768, any real account or credential.

## Gate results (run by the reviewer)

| Check                              | Result                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `bun run typecheck`                | pass                                                                   |
| `bun run lint`                     | pass                                                                   |
| `bun run test`                     | 1305 passed, 16 skipped, 2 files failed                                |
| `bun run build`                    | pass, "Built 26 inactive workflow exports", tree unchanged after build |
| `bun run format:check`             | pass                                                                   |
| `bun run integration` (Docker n8n) | not run: sandbox, and the demo guard                                   |

The 2 failing files are `tests/private-postgres.test.ts` and `tests/semantic-postgres.test.ts`: `initdb ... FATAL: could not create shared memory segment: Operation not permitted`. That is this sandbox, not the code; they need the main checkout or Docker. None of the 16 skips is in an outreach, Desk or redaction test file.

Note: `.agents/verify.sh` in fast mode prints `verify: nothing changed` on a clean tree, so a Stop hook after a merge commit checks nothing. The numbers above come from running `bun run verify` and the remaining steps by hand.

## What holds up

- Desk and outreach routes sit behind the unlock session cookie, an exact `Origin`, `Content-Type: application/json` and the `x-tend-csrf` header (`src/private-web.ts:241-249`), with tests for each rejection (`tests/desk-api.test.ts:225-237`). CSP is `default-src 'none'; connect-src 'self'`, so the Desk cannot reach anything but the local API.
- Private outreach routes (`/api/live/outreach/*`) sit after the Bearer check (`src/live-api.ts:415`); n8n has no route to approve, edit or skip (404, tested).
- `OUTREACH_ENABLED` defaults to off (`src/outreach-service.ts:169`); with it off `approvedEmail` returns nothing and `recordGmailDraft` throws (tested at `tests/outreach.test.ts:291`).
- The Gmail step is an HTTP Request to `users/me/drafts` only; exports are scanned for send endpoints and Gmail/Telegram nodes (`tests/outreach-workflows.test.ts:64`).
- An approval binds the text hash; an edit resets to pending; approvals expire after 24 h or on evidence change; the recipient is re-checked against stored identities at approve and at hand-off.
- Private exports 10-20, 22, 25, 26 save no execution data and point at `TendPrivate22`; fictional ones point at `TendReview21`. Workflow 22 keeps only allowlisted literal guard text or `HTTP nnn`, and `/api/live/failure-log` rejects anything else.
- Desk DOM is built with `textContent`, deep links pass `safeLink` (https only, no userinfo). Private error responses are fixed strings; `safeMessage` maps `uncited detail: ...` to a fixed sentence so draft text never echoes back.
- No real address, phone, token or message text found in the diff (only `@example.invalid` fixtures and one `someone@gmail.com` test literal for the recipient guard).

## Findings

### H1. The Gmail credential steps would grant full mailbox access, not gmail.compose (High, fixed on review/codex)

`docs/plans/outreach-status.md:57`, `src/outreach-workflows.ts:293`, `workflows/26-private-outreach-gmail-drafts.json` (node "Create Gmail draft").
Workflow 26 binds an n8n `gmailOAuth2` credential. n8n's `GmailOAuth2Api.credentials.ts` defaults that credential to six scopes, including `https://mail.google.com/` (full mailbox, a superset of send) and `gmail.modify`, unless "Define custom scopes" (`customScopes`) is switched on and `enabledScopes` is edited. The re-consent steps only say "create a new Gmail OAuth2 credential named for compose, sign in ... accept the consent screen".
Failing scenario: Adam follows step 2 as written after 14:00. The consent screen asks for full Gmail access, he accepts, and the credential bound to 26 can send, delete and read all mail. The brief's "never add gmail.send" is then met in name only. The repo already knows the right pattern: `src/integration.ts:377-381` sets `customScopes: true` with `enabledScopes: gmail.readonly` for the read credential.
Fix (commit on review/codex): the steps and the node note now say to switch on "Define custom scopes" and set the field to exactly `https://www.googleapis.com/auth/gmail.compose`, then check the Google consent screen lists only "Manage drafts and send emails". A test pins the note. No export test can check the scope itself, because scopes live in the credential, not the workflow, so this stays a human step to check at consent time.

### H2. The owner can approve a draft they never saw (High, open; needs a contract change)

`src/outreach-store.ts:283` (`approve` takes only `id`), `src/desk-api.ts:218-232` (`fields(data, ["id"])`), `src/outreach-store.ts:256-278` (`modelDraft`).
`plan()` stores a template draft, then the planner (23/25) calls `/draft` once per proposal, after Ollama replies (60 s timeout each), and `modelDraft` replaces the text while the item is still `pending`. Approve only names the item, so it approves whatever text is stored at that moment.
Failing scenario: the hourly planner runs; Adam has the Desk open (or just ran `/outreach`) and sees the template "Hi Mira, following up on ...". Before he clicks Approve, n8n saves the model text. His click approves the model text, its hash is bound, and workflow 26 creates a Gmail draft he never read. Reproduced on the fictional lane (vitest, from the repo root):

```ts
const { book, store } = createFixtureOutreachService();
const load = () => snapshotOf(store, "demo-owner");
const seen = book
  .list(load())
  .items.find((i) => i.reason === "overdue_owed_to_you")!;
// n8n's planner saves the model draft after the owner loaded the Desk
expect(
  book.modelDraft(
    seen.id,
    "Hi Mira, I have decided to cancel our deal.",
    load(),
  ).accepted,
).toBe(true);
const approved = book.approve(seen.id, load()); // the Desk sends only {id}
expect(approved.draft_text).not.toBe(seen.draft_text); // passes
expect(book.approvedEmail(load()).items.length).toBe(1); // the unseen text goes to Gmail
```

The owner still presses Send in Gmail, which is the last line of defence, but the brief requires approval of "that exact message".
Suggested fix: the Desk sends the `draft_text` (or its SHA-256) it rendered; `OutreachBook.approve(id, snapshot, expectedHash)` throws "draft changed since you opened it" on mismatch (add that phrase to `safeOutreachError`). For Telegram, show a short text-hash suffix in `/outreach` and require `/approve <id> <suffix>`, or refuse Telegram approval while `draft_source === "template"` and a model draft is pending. The Telegram part is a UX call for the lead.

### M1. Approved emails become duplicate Gmail drafts when the receipt step fails (Medium, open)

`src/outreach-store.ts:340-375` (`approvedEmail`, `recordGmailDraft`), `src/outreach-workflows.ts:270-313` (workflows 24, 26).
`approvedEmail` keeps returning an approved item until `recordGmailDraft` succeeds, and 24/26 run every 10 minutes. Nothing marks an item as handed off.
Failing scenario: drafts.create succeeds for item 1, then the HTTP node fails on item 2 (Gmail 429) or "Record draft in send ledger" fails (private API restarting, Header Auth not bound yet). The execution fails, no receipt is stored, and the next run creates the same Gmail draft again: up to 144 copies in the 24 h approval window, while the ledger shows none. Reproduced: after `book.approve(id, load())`, two consecutive `book.approvedEmail(load())` calls both return the item (no receipt recorded in between), so each 10-minute run hands it to drafts.create again.
Suggested fix: record `handed_at` when an item is returned, exclude handed-off items from `sendable`, and expire them with a visible reason ("Gmail receipt missing, check Gmail drafts") if no receipt arrives within the run timeout. Optionally set `onError: continueRegularOutput` on the create node so one failure does not drop the other receipts.

### M2. Two injection filters disagree, so the Desk and the planner treat the same message differently (Medium, fixed on review/codex)

`src/desk-model.ts:123-128` vs `src/outreach.ts:96-102`.
The Desk's "Held back" list and the planner's held-back list use separate regex sets. Outreach catches "act as ...", "api key / password / credentials"; the Desk catches "share all contacts".
Failing scenario: a received email "Please act as my assistant and confirm the meeting" is held back by the planner (no reply drafted) but shows on the Desk as a normal message, and any promise candidate from it gets a Confirm button. The reverse holds for "Could you share all contacts with the team?": the Desk holds it back while the planner proposes a reply from it.
Fix (commit on review/codex): one dependency-free module, `src/instruction-like.ts`, with the union of both pattern sets, used by both (desk-model is bundled for the browser, so it cannot import `outreach.ts`, which needs `node:crypto`). A test runs both functions over the same phrases.

### M3. Runtime claims are ahead of the runtime evidence (Medium, open)

`src/integration.ts:808-821`, `evidence/runtime-checks.json`.
The integration now imports 26 workflows and publishes 21, but it never forces a production failure and checks `/api/failure-log`, and never runs 23/24 in n8n (brief step 7 asks for both). The redactor and outreach Code nodes are tested only in `node:vm` (`tests/failure-redaction.test.ts`, `tests/outreach-api.test.ts`), not inside n8n. `evidence/runtime-checks.json` says "22 workflows imported" while the assertion now expects 26, so the recorded evidence predates the current tree.
Failing scenario: n8n wraps a Code-node error as `"invalid outreach plan [line 1]"`; the allowlist match in 22 fails closed to "unlisted error (text withheld)", and 21 is never shown to fire at all because `n8n execute` runs are not production runs. Nobody would notice until the live lane.
Suggested fix: add an integration step that activates a fictional workflow with a webhook or schedule trigger, makes it fail, and asserts one `failure_log` entry; run 23 and 24 against the fixture API and assert one mock Gmail draft after a fixture approval. Re-record the evidence after 14:00.

### L1. Telegram cannot run /dismiss although the Specification says it can (Low, open)

`src/telegram.ts:15` (guard regex has no `dismiss`), `Specification.txt` (22 Oct entry: "mark a pending candidate as not a promise with /dismiss <id>").
Failing scenario: Adam types `/dismiss c-123` in the control chat; the guard maps it to help and `/status`. Only the Desk button works. Either add `dismiss` to the guard regex and help text (fictional and live), or reword the Specification entry to say the Desk button.

### L2. Stale or inconsistent docs (Low, partly fixed on review/codex)

- `Specification.txt` 22 Oct entry: "import all 21 exports" (now 26). Fixed.
- `docs/plans/outreach-status.md:19`: "25 and 26 ... carry no error workflow yet"; both point at `TendPrivate22`. Fixed.
- `.env.example` has no `OUTREACH_ENABLED=false` line. Open: `.env*` edits are hook-guarded, so the lead or Adam should add it.
- `schema/001-tend.sql:38`: the proposed `commitments.status` CHECK has no `dismissed`, while the engine now writes it. Open.

### L3. The private-route HTTP test passes on an empty store (Low, open)

`tests/outreach-api.test.ts:202-276`. The live store has no records, so `plan` returns `created: []` and `approved-email` would be empty whether the kill switch is on or off. The default-off behaviour is proved by the unit test at `tests/outreach.test.ts:291`, so this is a coverage gap, not a hole: seed the fictional records and an approved item so the HTTP test fails if `createPrivateOutreach` ever reads `OUTREACH_ENABLED` wrongly.

### L4. The fixture API accepts approvals from any local page (Low, by design, fictional only)

`src/outreach-service.ts:107-141`, `src/server.ts`. `/api/outreach/approve|edit|skip` on 127.0.0.1:18767 have no auth and parse JSON whatever the content type, so any web page open in the browser can POST a `text/plain` approval. Only the mock Gmail and `@example.invalid` recipients sit behind it, so the impact is a fictional demo state change. Worth one line in the demo notes; not worth code before the demo.

### L5. The failure-analysis plan can copy provider text into .scratch (Low, open)

`docs/plans/n8n-failure-analysis.md` step 4: `docker logs ... | grep -iE "error|failed" | cut -c1-200`. n8n error lines can quote provider responses (Gmail snippets, contact names). `cut -c1-200` shortens, it does not redact. Keep only workflow ID, node name and error class, for example `sed -E 's/(message|error)":"[^"]*/\1":"<withheld>/'`, or count by workflow and node only.

### L6. The private failure-log allowlist depends on the working directory (Low, open)

`src/failure-redaction.ts:33` reads `workflows/` relative to the cwd. If the private API LaunchAgent starts elsewhere, the allowlist is empty: it fails closed (only `HTTP nnn` and the withheld marker pass, and 22 then gets 400s on every allowlisted message). Resolve the path from `import.meta.url` like `private-web.ts` does for its assets.

## Fix commits on review/codex for the lead to cherry-pick

Each is a separate commit; the test in each fails without the fix (checked by reverting the source change).

- `d1d09c1` H1: gmail.compose-only custom scopes in the re-consent steps and the workflow 26 node note; test in `tests/outreach-workflows.test.ts`.
- `430c2c3` M2: shared `src/instruction-like.ts` for the Desk and the planner; test in `tests/desk-model.test.ts`.
- `0fee381` L2: Specification export count (21 → 26). The outreach-status error-workflow line is fixed inside `d1d09c1`.
- `af57042` follow-up to `430c2c3`: my first version of the shared filter used the Desk's `[^.\n]` and so stopped the planner matching "Ignore\nthe previous instructions" across a line break. Restored `[^.]` and added that phrase to the test. Pick it together with `430c2c3`.

Cherry-pick dry run onto `improve/lead` at cd5ff58: `d1d09c1`, `0fee381` and `af57042` apply cleanly; `430c2c3` conflicts only on the import lines of `tests/desk-model.test.ts` (keep both `import { readdirSync } from "node:fs";` and `import { isInstructionLike } from "../src/outreach.ts";`). If `web/private/app.js` ever conflicts, run `bun run build` rather than merging the minified file by hand. After the picks, `bun run build` leaves no diff and the desk-model, outreach and outreach-workflows tests pass (43).

## Re-review 1: improve/lead at cd5ff58 (22 Oct, 11:00 Paris)

New since 05f7050: workflows 22-26 listed on How it runs (`src/desk-model.ts` `workflowCatalog`), and the Desk preview server now goes through `createLiveServer` with `createPrivateOutreach` (`:memory:` ledger, `OUTREACH_ENABLED=false`, in-memory `InternalAuth`, ports 18767/18768/18769/5678 refused). No new findings. The one merge conflict (imports in `tests/desk-model.test.ts`) was resolved by keeping both imports. On the merged tree: typecheck, lint, build (26 exports, no diff), format pass; 1307 tests passed, 16 skipped across 55 files (an earlier count of 1309 wrongly included my scratch repro file, which vitest picked up from `.scratch/`; it is now outside the test glob); the same 2 Postgres files fail on sandbox shared memory. H2, M1 and M3 are still open.

## Re-review 2: improve/lead at 492514b (22 Oct, 11:05 Paris)

The lead picked `d1d09c1` (as f3841b4), `430c2c3` (as 2a2dc0e) and `0fee381` (as 492514b), but not `af57042`. improve/lead therefore still has the narrowed `[^.\n]` filter, and the planner misses "Ignore\nthe previous instructions". **Pick `af57042` too.** Merging improve/lead into review/codex conflicted on exactly those lines, and I kept the `[^.]` form.

New commit `0811861` partly closes M3. The integration now plans with 23, checks there is no mock draft before approval, approves one fictional email and runs 24 until there is exactly one mock drafts.create receipt. It also publishes a fictional webhook workflow that throws "Mira Tan F17" text and asserts that 21 records only names, the execution ID and the withheld marker. All of it runs in the isolated container on an ephemeral port, never on 5678 or 18768. Workflow 21 now uses the same allowlist redactor as 22, which also fixes a leak I had not flagged: the old 200-character cut kept emails, URLs and body text. The unit test now checks that an email, a URL and body text are withheld. M3 stays open until `bun run integration` actually runs (Docker, after 14:00) and `evidence/runtime-checks.json` is re-recorded. The evidence file still says "22 workflows imported".

Gate on the merged tree: typecheck, lint, build (26 exports, no diff) and format pass. Tests: 1307 passed, 16 skipped, 55 files; the same 2 sandbox Postgres files fail. Still open: H2, M1, M3 (the run itself), and L1, L3 to L6.

## Re-review 3: improve/lead at 03524f6 (22 Oct, 11:10 Paris)

- `af57042` is in improve/lead as 03524f6. The shared filter there now uses `[^.]` again.
- **H2 fixed (6a584e3, kept by the merge 23306ee).**
  - Each item carries `text_code`, the first 8 hex characters of SHA-256 of the draft. `OutreachBook.approve(id, seen, snapshot)` throws "draft changed since you saw it" on a mismatch.
  - The Desk route requires `{id, text_code}` matching `^[0-9a-f]{8}$` (otherwise 400), and the client sends the code of the item it rendered.
  - Telegram takes `/approve ID CODE`, and `/outreach` lists the code. The fixture route and the integration pass the code; a missing code becomes `""` and is refused.
  - The new phrase is in both `safeOutreachError` and `safeReasons`. Telegram refusals go through `safeOutreachReason`, so no draft text is echoed back.
  - Re-checked my repro: after a model rewrite, approving with the old code throws, and approving with the current code approves exactly the current text.
  - 32 bits is enough here. The code catches a stale view; it is not an authorization token (that is still the session plus CSRF, or the owner-only chat).
- New, Low: after `/edit` in Telegram, the reply prints the new text but not its code (`src/telegram.ts`, `outreach_item` branch). The owner has to run `/outreach` again before `/approve`. Add `' code '+string(o.text_code)` to that line.
- `3e2f0b0` (`repeatsEvidence`) rejects model drafts that echo the cited message, and the template is kept. It is safe: it can only reject. An empty model reply is now logged as "model repeated the cited message" instead of "empty draft"; that is cosmetic.
- Gate on the merged tree: typecheck, lint, build (26 exports, no diff) and format pass. Tests: 1315 passed, 16 skipped, 55 files; the same 2 sandbox Postgres files fail.

Still open: M1 (duplicate Gmail drafts, the lead's next item), M3 (the integration run and re-recorded evidence, in progress), and L1, L3 to L6.

## Re-review 4: improve/lead at 3ae99d6 (22 Oct, 11:15 Paris)

- **M1 fixed (2317c16).** `approvedEmail` now sets `handed_at` and logs `handed_to_gmail`, and leaves out items already handed over. A failed receipt step therefore can no longer create the same Gmail draft every 10 minutes. A late receipt is still accepted, and `approve` clears the mark. The tests cover the single hand-off, the late receipt and a new hand-off after edit and re-approval.
- **New, Low.** If drafts.create itself fails, the item stays "Approved" on the Desk until the 24 h window expires. Nothing tells the owner the draft never reached Gmail. The only retry is Edit, then Approve, because `approve` accepts only pending items. Suggested fix: in `view()`, flag an approved email with `handed_at` set and no receipt after one run interval as "Gmail draft not confirmed, check Gmail or approve again", and let Withdraw/Edit say so.
- **Telegram /edit code fixed (3ae99d6).** The reply now ends with "Code xxxxxxxx.", and a vm test runs the reply code. It went into the shared reply code, so the live export 10 changes too. That is harmless: the live guard still strips the outreach commands, so the live lane never produces an `outreach_item`.
- **Gate on the merged tree** (Postgres and Docker tests excluded at the lead's request, demo load): typecheck, lint, build (26 exports, no diff) and format pass. 52 files, 1315 passed, 2 skipped.

Still open: M3 (the integration run and re-recorded evidence, held until the lead clears Docker use), the Low above, and L1, L3 to L6.

## Re-review 5: improve/lead at 450591f (22 Oct, 11:40 Paris)

- **M3 closed.** I ran `bun run integration` myself on the merged tree, in the isolated Docker container (the lead cleared Docker until 12:25): `{"pass":true,"checks":23}`. The checks that cover this branch passed:
  - 26 workflows were imported and 21 was published.
  - A forced fictional production failure reached 21 with its message withheld.
  - 23 planned 4 cited drafts. `/outreach`, `/edit`, `/approve` and `/skip` ran through the native Telegram trigger, and 24 created exactly one mock Gmail draft.

  I did not commit the evidence files my run rewrote (the lead owns `evidence/`).

- **F8, private bot outreach routing (14b46f8).** `PostgresStore` hands outreach commands to the book inside the scoped transaction. Other commands fall through, and the live guard now admits the four outreach commands.
  - Refusals are fixed phrases. Reply data sits in `live_reply_ledger` only until it is sent, then it is cleared, as for `/prep`.
  - Low: the parity test runs on an empty book, so it covers listing and refusal but never a successful `/approve ID CODE` through the private bot.
  - Low: book writes (SQLite) are outside the PostgreSQL transaction. A rolled-back reply-ledger insert can therefore leave an approval recorded with no reply sent. Re-sending `/approve` then answers "cannot approve an approved item", which is safe.
- **bb70be4 and bf2e826.** Style examples are scrubbed of dates, links, emails and numbers before they reach the model. Drafts that copy a style example or the purpose text are rejected. Both checks only narrow what is accepted. The scrubbed examples are stored in the private outreach SQLite and are not exposed by `view()`.
- **`src/outreach-demo.ts`.** A fictional demo on ports 18831/18832 that refuses 18767, 18768, 18769 and 5678.
- **Process, for Adam to confirm.** `Specification.txt` (f71c5cd) records that, before the demo, the live editor's workflows 11 and 12 were rebound and republished (from 08:32 UTC) and 59 workflows were archived. The brief allows live changes only after 14:00, and archiving only of the workflows Adam approves. If Adam approved this directly to the lead, there is nothing to do; otherwise it needs his attention. It is not a code finding.
- **Gate.** Typecheck, lint, build (26 exports, no diff) and format pass. Unit tests (Postgres-named files excluded): 52 files, 1319 passed, 2 skipped. `tests/live-store-parity.test.ts` passes in full, including the new outreach test. Integration: 23 out of 23.

Still open: "Gmail draft not confirmed" (Low, which the lead lists as a known limitation), L1 (Telegram `/dismiss`, still not in the guard), and L3 to L6.

## Re-review 6: improve/lead at 0ae4214 (22 Oct, 11:40 Paris)

Docs only. `Specification.txt` now says the pre-demo relink of 11/12 and the archive of 59 workflows were done on Adam's written instruction of 10:25, which replaced the after-14:00 rule for those two actions. 7 workflows marked "ask" were kept. I take this from the lead's message and the entry. Adam should confirm it in his own review of the lead's report; I have no record of that instruction in this session. The lead will list Lows (a) and (b), Telegram `/dismiss` and L3 to L6 in the final report as open items for after 14:00. There is no code change since 450591f, so the gate results of re-review 5 stand.

## Low-item fixes (22 Oct, 11:45-11:58 Paris, on Adam's 11:41 decision)

One commit per item on review/codex. Each test was checked to fail with the fix reverted. All nine cherry-pick cleanly onto improve/lead 0ae4214, in this order; after the picks, `bun run build` leaves no diff and the affected test files pass (98 tests).

| Commit    | Item                                                                                                                                                                                    | Test                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `66c1940` | L1: `/dismiss ID` passes both Telegram guards and is in both help texts                                                                                                                 | `tests/telegram.test.ts`                                                                                                          |
| `b7fb46f` | L6: failure-log allowlist resolved from `import.meta.url`, not the cwd                                                                                                                  | `tests/failure-redaction.test.ts` (chdir to a temp dir)                                                                           |
| `8dbeaf8` | L4: **withdrawn as a finding**. The fixture API already requires `application/json` on every POST, so a cross-origin page cannot approve. This commit only pins that with a test        | `tests/outreach-api.test.ts`                                                                                                      |
| `f1686e6` | Gmail not confirmed: `gmail_unconfirmed` when an email was handed to Gmail 15 min ago with no receipt, and the Desk says to check Gmail drafts or edit and approve again                | `tests/outreach.test.ts`, `tests/desk-client.test.ts`                                                                             |
| `60cac11` | L3: only `OUTREACH_ENABLED=true` exactly opens the private send path                                                                                                                    | `tests/outreach-api.test.ts`                                                                                                      |
| `ea10853` | SQLite outside the PostgreSQL transaction: a resent `/approve ID CODE` returns the existing approval (no second log entry, no longer window), so a rolled-back bot reply is recoverable | `tests/outreach.test.ts`                                                                                                          |
| `a02c1f0` | Parity: a real `/approve ID CODE` through the private bot on PostgreSQL (plan, edit, stale code refused, current code approved). `createPrivateOutreach` gains an optional clock        | `tests/live-store-parity.test.ts`, **not run here** (needs Docker PostgreSQL); the same flow passed on the live-mode SQLite store |
| `1ff446a` | L5: the failure-analysis plan keeps only workflow IDs, node names and counts from `docker logs`                                                                                         | `tests/failure-analysis-plan.test.ts` runs the documented filter on a fictional line                                              |
| `c4e25f4` | L2: the proposed `commitments.status` CHECK allows `dismissed`                                                                                                                          | `tests/schema-statuses.test.ts`; `bun run schema:check` not run (Docker)                                                          |

Not done: `.env.example` (`OUTREACH_ENABLED=false`). This session's sandbox denies reading `./.env.*`, so the lead or Adam has to add that line.

Gate on review/codex after these commits: typecheck, lint, build (26 exports, no diff) and format pass. Unit tests without the Docker-backed files: 53 files, 1307 passed, 2 skipped.

## Re-review 7: improve/lead at 3b05416, plus the extraction-candidates parity test (22 Oct, 12:00 Paris)

`3b05416` replaces the per-minute `/api/live/model-input` scan of every record with `extractionCandidates(owner, key)`. The PostgreSQL version filters in SQL with the same rule as SQLite: kind, direction, attribution, eligibility and cancelled, plus "no attempt at this content_hash" when no key is given. No findings.

`b224952` adds the parity test the lead asked for, in `tests/live-store-parity.test.ts`. It was run against Docker PostgreSQL, which the lead cleared for this file only, and all 22 parity tests pass. That includes `a02c1f0`'s private-bot `/approve ID CODE` test, which is therefore now verified. Making the SQL attempt filter always true makes the new test fail. The commit cherry-picks cleanly onto 3b05416 on its own.

## Promise threads: improve/desk-ui 292e532..9610c3b (22 Oct, 17:45 Paris)

Requested by tend-desk. Reviewed the five commits against the five focus points. Repros run against an export of 9610c3b; the repro file is `.scratch/review-repro/promise-threads.repro.ts` (gitignored, fictional data only). All three repro tests fail on 9610c3b, which confirms P1-P3.

| ID | Severity | Location | Finding |
|---|---|---|---|
| P1 | High | `src/promise-threads.ts:64` | Stopwords are checked after stemming, so "the" becomes "th" and counts as a content word. False links between different asks from the same person. |
| P2 | High | `src/promise-threads.ts:208` | Thread IDs are reused, so a member the owner separated can be pulled back into the thread they split it from. |
| P3 | Medium | `src/outreach.ts:263` | The thread's follow-up can move to a new lead member, which plans a second follow-up for one promise. |
| P4 | Medium | `src/postgres-store.ts:1741` | The savepoint catch swallows every error, not only the timeout. |
| P5 | Low | `src/engine.ts:3280`, `src/postgres-store.ts:2310` | `/done` and `/cancel` also close pending members whose evidence is invalid. |
| P6 | Low | `src/promise-threads.ts:19` | Verified groups are remembered in a process-global map. |

- **P1 (High): focus 1, a false link joins two asks.** At `src/promise-threads.ts:64`, `actionTokens` strips the endings `ing|ed|s|e` before the stopword filter runs.
  - "the" becomes "th", which is not in the stopword list, so nearly every action carries a shared token. "please" becomes "pleas", and "are" becomes "ar".
  - **Failing scenario:** Mira writes "send the signed contract" in one message and "review the signed contract" in another. `tokenSimilarity` returns 0.75, above `THREAD_TOKEN_THRESHOLD` 0.7, so the two different asks are linked automatically. Without "th" the score is 4/6 = 0.667 and they stay apart.
  - The calibration note at line 37 ("send the contract" vs "send the demo") also only clears by one token for the same reason.
  - **Fix:** filter stopwords before stemming as well as after, and add the repro pair as a test.
- **P2 (High): focus 1 and 2, an owner override is undone.** At `src/promise-threads.ts:208`, a new pair always takes the ID `T<earlier commitment_id>`. Both stores then insert the thread with `INSERT OR IGNORE` (engine) or `ON CONFLICT DO NOTHING` (PostgreSQL).
  - When the owner separates the member whose ID names a thread of three or more, the thread keeps that ID with the remaining members.
  - **Failing scenario:**
    1. A ("send the signed contract"), B and C ("send the contract") from F17 auto-link as `T<A>`.
    2. The owner runs `/separate A`. Overrides A-B and A-C are stored, and B and C stay in `T<A>`.
    3. D ("send the signed contract copy now") arrives. D fits A but not B or C, so `linkThreads` pairs A with D under `T<A>`.
    4. A is back in the same thread as B and C, despite the owner's "Not the same ask". The Desk shows one card again, and `/done` on any member closes all four.
  - **Reachable from the UI:** "Not the same ask" is offered on every member except index 0. If an older sighting joins later (a history backfill), the naming member is no longer index 0.
  - **Fix:** never reuse an existing thread ID for a new pair. Either pick a fresh one (for example `T<earlier>_<n>`), or make the pair insert fail instead of ignoring the conflict.
- **P3 (Medium): focus 4, two follow-ups for one promise.** At `src/outreach.ts:263`, `threadRepresentatives` picks the earliest *confirmed* member as the thread's lead. That lead can change after an item was planned.
  - **Failing scenario:**
    1. The owner confirms sighting x2. `plan()` creates `overdue_owed_to_you:<x2>`.
    2. An older sighting x1 of the same ask arrives and links into the thread. The owner confirms it with "Confirm and link".
    3. The lead becomes x1, so the next `plan()` creates `overdue_owed_to_you:<x1>`.
    4. `refresh()` reads `split(":")[1]` = x2, which is still confirmed and valid, so the first item stays pending. Two live drafts now exist for the same promise.
  - `withinRateLimit` only compares exact `item_key` values, so it does not stop this.
  - **Fix:** when planning a threaded commitment, treat a prior item on any member of the thread as blocking. Also expire a thread item in `refresh()` once its commitment is no longer the lead.
- **P4 (Medium): focus 3, a swallowed error hides real bugs.** At `src/postgres-store.ts:1741`, the bare `catch {}` around `linkWithin` turns every failure into "no thread" with no trace. That includes a TypeError in `linkThreads`, a CHECK violation on `thread_id ~ '^T[A-Za-z0-9_-]{1,80}$'` (the SQLite table has no such CHECK) and an FK violation.
  - **Failing scenario:** a future record-key format containing ":" makes every PostgreSQL link fail its CHECK, while SQLite keeps linking. The parity test would pass the empty case, and production would silently never thread.
  - **Fix:** roll back to the savepoint and return `[]` only for SQLSTATE 57014 (`query_canceled`). For any other error, roll back to the savepoint, count or log a fixed phrase (no text), and rethrow or record it.
  - Also, `statement_timeout` bounds each statement, not the 2 s total the commit message describes.
- **P5 (Low): focus 2.** At `src/engine.ts:3280` and `src/postgres-store.ts:2310`, `/done` and `/cancel` close every pending member, including members with `evidence_valid === false`. `/confirm` skips those members, and its comment says they need owner review.
  - **Fix:** use the same filter as `/confirm`.
- **P6 (Low): focus 1.** At `src/promise-threads.ts:19`, `threadGroups` is a module-global map. Groups passed by one Desk GET stay in force for `addCandidate` links until the next Desk GET in the same process.
  - **Failing scenario:** the owner removes a verified group from the policy. Until the Desk is reopened, new candidates from either contact can still auto-link.
  - Tests that pass groups for `exampleLivePolicy.principal_id` also leak them into later tests in the same worker.

**Checked with no finding:**
- **Focus 1:** `personKey` uses only `contact_id` or an accepted proof kind. Names never count.
- **Focus 2:** `/confirm` confirms only valid pending members. `/separate` rejects a single member.
- **Focus 5:** the new error strings are fixed phrases.
  - The Desk now shows each sighting's `evidence_reference`, which contains the account email and message ID. The page is owner-only, behind the session, CSRF and `default-src 'none'`, so this is acceptable. Keep it out of any export or log.
- The Desk GET now writes thread rows. It is not exploitable cross-site (linking is automatic anyway), but it is a write on GET.
