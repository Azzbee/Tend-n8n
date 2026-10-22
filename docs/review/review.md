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
Failing scenario: the hourly planner runs; Adam has the Desk open (or just ran `/outreach`) and sees the template "Hi Mira, following up on ...". Before he clicks Approve, n8n saves the model text. His click approves the model text, its hash is bound, and workflow 26 creates a Gmail draft he never read. Reproduced in `.scratch/review/race.test.ts` on the fictional lane: `modelDraft(id, "Hi Mira, I have decided to cancel our deal.")` is accepted, then `approve(id)` returns that text and `approvedEmail` hands it to Gmail. The owner still presses Send in Gmail, which is the last line of defence, but the brief requires approval of "that exact message".
Suggested fix: the Desk sends the `draft_text` (or its SHA-256) it rendered; `OutreachBook.approve(id, snapshot, expectedHash)` throws "draft changed since you opened it" on mismatch (add that phrase to `safeOutreachError`). For Telegram, show a short text-hash suffix in `/outreach` and require `/approve <id> <suffix>`, or refuse Telegram approval while `draft_source === "template"` and a model draft is pending. The Telegram part is a UX call for the lead.

### M1. Approved emails become duplicate Gmail drafts when the receipt step fails (Medium, open)

`src/outreach-store.ts:340-375` (`approvedEmail`, `recordGmailDraft`), `src/outreach-workflows.ts:270-313` (workflows 24, 26).
`approvedEmail` keeps returning an approved item until `recordGmailDraft` succeeds, and 24/26 run every 10 minutes. Nothing marks an item as handed off.
Failing scenario: drafts.create succeeds for item 1, then the HTTP node fails on item 2 (Gmail 429) or "Record draft in send ledger" fails (private API restarting, Header Auth not bound yet). The execution fails, no receipt is stored, and the next run creates the same Gmail draft again: up to 144 copies in the 24 h approval window, while the ledger shows none. Reproduced in `.scratch/review/race.test.ts` (second test: two consecutive `approvedEmail` calls both return the item).
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

See `git log improve/lead..review/codex`. Each fix is its own commit with a test.
