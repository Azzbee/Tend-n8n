# Verification findings (branch improve/verify)

Summary: _written at the end of the run._

Environment for every repro: fictional data only. Fixture API `TEND_DEMO_PORT=18851 TEND_DEMO_DB=.scratch/verification/demo.sqlite TEND_OUTREACH_DB=.scratch/verification/outreach.sqlite node --experimental-strip-types src/server.ts`; isolated n8n container `tend-verify-n8n` (same image digest as live, 127.0.0.1:18855) with workflows 01-09, 21, 23, 24 imported after `sed 's/:18767/:18851/g'`; private composition harness `.scratch/verification/private-harness.ts` (real `createLiveServer` + `createPrivateOutreach` over `createDeskFixtureStore`). Evidence paths are under `.scratch/verification/`.

| ID  | Severity | Owner                                       | Status | Title                                                                                |
| --- | -------- | ------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| F1  | high     | tend-outreach                               | open   | Model draft that only repeats the contact's quote is accepted as the owner's message |
| F2  | low      | tend-outreach                               | open   | Telegram refusals for /approve and /edit hide the rule reason                        |
| F3  | medium   | tend-lead                                   | open   | Error handler 21 keeps URLs, emails and message text; the UI says they are dropped   |
| F4  | medium   | tend-lead                                   | open   | How it runs shows no last-run status in the real private composition                 |
| F5  | low      | tend-desk                                   | open   | How it runs omits workflows 22-26; private failure log labelled as 21                |
| F6  | low      | tend-desk (needs a flag from tend-outreach) | open   | Desk promises a Gmail draft while `OUTREACH_ENABLED=false`                           |
| F7  | medium   | tend-lead                                   | open   | `bun run integration` does not run 23/24 or force a failure into 21                  |
| F8  | medium   | tend-lead                                   | open   | Private Telegram bot cannot route /outreach /approve /edit /skip                     |
| F9  | low      | tend-desk                                   | open   | 1440 px Desk: Outreach queue squeezed into the right column                          |
| F10 | low      | tend-outreach                               | open   | `style_basis` never reaches the owner                                                |

## F1: model draft that only repeats the contact's quote is accepted (high, tend-outreach)

Steps:

1. Start the fixture API on 18851 and the isolated n8n as above.
2. `docker exec tend-verify-n8n n8n execute --id TendReview01` through `05` and `07`, then `/confirm <g1 candidate> 2026-10-15` through `/api/telegram/command`.
3. `docker exec tend-verify-n8n n8n execute --id TendReview23` (local Ollama qwen3:0.6b drafts).
4. `curl -s 127.0.0.1:18851/api/outreach`.

Expected: every draft is a message from Adam to Mira, citing the evidence.
Actual: two of four proposals have `draft_text` exactly equal to Mira's own words, `"I will send the demo by 2026-10-15."` (`overdue_owed_to_you` email Oae587f9ec9, `reply_waiting` LinkedIn O49fdd3dbbe). The ledger records `model_draft` with `recipient_examples` for both; the template draft ("Hi Mira, following up on ...") was replaced. Approving either would send Mira her own promise back as Adam's message. The validator rejects uncited dates (two other drafts were rejected for `uncited detail: 2026-10-16`) but accepts a draft that is a verbatim copy of the evidence.
Evidence: `cmd/outreach-after-23.json`, `cmd/n8n-23.log`, `cmd/ledger-after-24.json`.
Suggested check: reject a model draft whose normalized text equals (or is contained in) a cited evidence text, or that speaks in the contact's first person; keep the template. Add a test with this exact output.

## F2: Telegram refusals hide the rule reason (low, tend-outreach)

Steps: `/edit O07d0c471e4 Hi Mira, see https://evil.example/x` and `/approve <a skipped id>` through `/api/telegram/command` on 18851.
Expected: the reply names the rule, as the Desk does ("Not changed: fill in the bracketed placeholder first.").
Actual: both reply `"Command failed. Use /help for examples."`. The refusals themselves are correct.
Evidence: `cmd/telegram-commands.txt`.

## F3: error handler 21 keeps URLs, emails and message text (medium, tend-lead)

Steps:

1. Import `.scratch/verification/n8n/force-failure.json` (webhook → Code node that throws `Fictional failure for mira@example.invalid see https://leak.example/item?id=g1 BODY:I will send the demo by 2026-10-15. XXX...` with 300 extra characters), `settings.errorWorkflow = TendReview21`; publish it and 21; `n8n start`.
2. `curl 127.0.0.1:18855/webhook/verify-forced-failure`.
3. `curl 127.0.0.1:18851/api/status` → `failure_log`.

Expected: names, node and a short message without URLs or item data. How it runs says "Kept: workflow and node names and a message cut to 200 characters. Dropped: stack traces, URLs and all message data."
Actual: 21 fires on the production failure (good) and cuts to 200 characters, but the entry keeps the email address, the URL with its query and the message body verbatim. 21's Code node only does `raw.replace(/\s+/g,' ').slice(0,200)`. The private redactor (22, `createFailureLog`) withholds the same message entirely (`failure message is not redacted`), so only the fictional lane is affected. Fictional data only, but the stated guarantee is false and the brief asks for "no item data".
Evidence: `cmd/failure-log.txt`, `cmd/redact-probe-22.txt`.

## F4: no last-run status in the real private composition (medium, tend-lead)

Steps: start `.scratch/verification/private-harness.ts`, open `http://127.0.0.1:18854/private`, unlock, open How it runs.
Expected (brief section 5): each workflow with its last-run status.
Actual: every one of the 21 rows reads "No run data on this device". `createLiveServer` (`src/live-api.ts:238`) passes `failureLog` but no `workflowRuns` to `createPrivateWebHandler`, so the hook tend-desk documented is never wired. The fictional dev server shows statuses only because it fakes them.
Evidence: `screens/1440-how-it-runs.jpg`.

## F5: How it runs omits 22-26; private failure log labelled as 21 (low, tend-desk)

Same steps as F4. The classroom lane lists 01-09 and 21; the private lane lists 10-20. Workflows 22 (private error handler), 23/24 (fictional outreach) and 25/26 (private outreach) are missing, though the pipeline and outreach queue depend on them. On the private page the log heading reads "Failure log · what 21 kept" while the entries come from 22.

## F6: Desk promises a Gmail draft while sending is switched off (low, tend-desk; flag from tend-outreach)

Steps: harness runs with `OUTREACH_ENABLED=false` (the default). Approve the email nudge on the Desk.
Actual: banner "Approved. Tend creates a Gmail draft; you press Send yourself." and the card says "Waiting for the Gmail step to create the draft." With the kill switch off, `approved-email` returns nothing, so no draft will ever be created and nothing tells the owner why. `OutreachService.list()` exposes no sending-enabled flag for the Desk to read.
Evidence: `screens/1440-outreach-approved-banner.jpg`.

## F7: integration does not cover outreach or a forced failure (medium, tend-lead)

`src/integration.ts` imports 26 workflows and publishes 21 but never executes 23 or 24, never forces a failure into 21 and never checks the redacted log. Brief section 7 lists all three as required integration steps. I ran them by hand (O1, O4, E1 in the feature map); E1 is how F3 was found.

## F8: private Telegram bot cannot route outreach commands (medium, tend-lead)

From `docs/plans/outreach-status.md` "Pending 1", confirmed in code: `PostgresStore.command` has no `commandExtension`, so on the private lane /outreach /approve /edit /skip never reach the outreach book. Brief section 6 requires approval from Telegram as well as the Desk. Fictional lane works (O5).

## F9: Outreach queue squeezed into the right column at 1440 px (low, tend-desk)

At 1440 px the Outreach queue sits under "Before you meet" in a ~340 px column. With four drafts the page scrolls for several screens with the left three columns empty. Evidence: `screens/1440-outreach-whatsapp-approved.jpg`.

## F10: `style_basis` never reaches the owner (low, tend-outreach)

Items returned by `/api/outreach`, `/private/api/outreach` and Telegram /outreach have no `style_basis` field; it appears only in the ledger. The owner cannot tell whether a draft follows their style for that contact (brief section 6).

## Not findings (checked and explained)

- The unexpected "Session expired · locked" at 10:37 came from tend-desk unlocking another preview on 127.0.0.1 in the same Chrome profile (cookies are scoped by host, not port). Real use has one private API.
- The first navigation by the Chrome extension to a private page returns 403 ("requires this laptop"); a same-origin reload loads it. The extension's navigation is treated as cross-site; a typed URL is not.
- People history shows only Email and Calendar records for Mira Tan while the Desk cites LinkedIn and WhatsApp records: the fictional `exampleLivePolicy` has no social accounts, so the history API leaves those sources out. Fixture shape, not a product bug.
- /help is answered inside workflow 10's guard, so the store route returning "Command failed" for /help is expected. /setup is the private API's web setup page, not a bot command.
