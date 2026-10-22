# Verification findings (branch improve/verify)

## Summary (22 Oct 2026, 11:35 Paris, merged improve/lead 450591f)

39 feature-map rows: 32 green, 1 not applicable (T3: /setup is a web page, not a bot command), 6 green where it could run with the rest deferred to a named owner (E2, B1, O5, O8, H1, C2). Every row was run against fictional data on spare ports and an isolated n8n; nothing touched the live n8n, the private API on 18768 or a real account.

- Green, seen working: adapters 01-09 in an isolated n8n (same image as live) and in `bun run integration` (18/18 at 10:40); Telegram commands on the fictional lane; private workspace unlock and lock (no private text left in the DOM, API 401); every Desk action (confirm, not a promise, mark done, outreach approve, edit, skip, withdraw, copy and deep link); the phone review at a real 390x844 viewport (headless Chromium) and the Desk at 1440 px in Chrome; contrast (0 elements below 4.5:1), visible focus, zero non-local requests; outreach planner 23 → Telegram /approve → workflow 24 → mock Gmail draft with ledger; rate limit and quiet hours; error handler 21 on a real production failure; a canvas note on all 26 exports.
- Twelve findings. Fixed and re-verified: F1 (high: model drafts that were the contact's own quote), F2, F3, F5, F6, F9, F10, F12. Mitigated: F11 (safe, but qwen3:0.6b never produces a usable draft; a model-size decision for Adam). Deferred by design: F4 (no last-run status; the private API cannot read n8n's database). Closed on tend-lead's committed evidence: F7 (integration 23/23 at f827987, again at 450591f). F8 fixed and re-verified against PostgreSQL; its live effect needs the workflow 14 redeploy after 14:00. Previously: F8 (private bot outreach routing, 14b46f8; the Postgres parity test and the workflow 14 redeploy wait until after 14:00).
- Deferred to tend-lead after 14:00 (demo guard): runtime of workflows 20, 22, 25 and 26; the workflow 14 redeploy that puts the F8 fix in the live bot; the n8n editor view of the new workflows (needs an owner login the verifier must not create); Google re-consent for real Gmail drafts is Adam's step.
- Leftovers: fictional Node servers on 18851-18861 and 18871-18876 the sandbox cannot signal (`lsof -ti tcp:<port> | xargs kill` to stop them); two detached checkouts under `.scratch/verification/` (removed at 11:26: vitest was also collecting their test files); stopped container `tend-verify-n8n`.
- Known limits of this verification: Chrome on this machine would not resize below 1440 px, so 390 px used a Playwright container; the extension's first navigation to a private page is treated as cross-site (403) and needed a same-origin reload; two previews on 127.0.0.1 share cookies, so parallel agents log each other out.

Change of plan (11:41, relayed by tend-lead): Adam decided that everything must end up fully working, with no deferrals. tend-lead will deploy 20, 22, 25 and 26, redeploy 14, add real run status for How it runs (F4) and a larger local model (F11), then merge to master. After the "deployed" message the verifier re-runs every fictional row. Live rows (private Desk on 18768, the live bot's /outreach, live How it runs) sit outside the verifier's brief ("never touch the live n8n, the live private API on 18768 or real accounts"), so they wait for Adam to confirm in the verifier's own session.

Live state at 13:05 (read-only, master a5e9b33; details in feature-map.md "Live re-check"): green 11, 12, 15, 18, 19, 22, Desk render, lock/unlock, F4 run status live. Open, owner tend-lead: L-5 planner 25 failed its first production run (13:00, node "Plan outreach"); L-6 the live outreach queue holds 585 pending reply_waiting email drafts (nothing can send, but the Desk is flooded; rule fix for tend-outreach: exclude bulk senders, require a verified person, cap per run); L-2 WhatsApp 17 failed 13:00. Pending Adam: live /outreach from his phone (14), Gmail consent for 26. Pending tomorrow 09:00: the first scheduled run of 20. Not verifiable by the verifier: n8n-side errorWorkflow settings and 26's credential scope (live n8n API 401, no sign-in).

Decisions for Adam: accept template-only outreach drafts or choose a larger local model (F11); accept "No run data on this device" on How it runs or fund a read path to n8n's executions (F4).

Environment for every repro: fictional data only. Fixture API `TEND_DEMO_PORT=18851 TEND_DEMO_DB=.scratch/verification/demo.sqlite TEND_OUTREACH_DB=.scratch/verification/outreach.sqlite node --experimental-strip-types src/server.ts`; isolated n8n container `tend-verify-n8n` (same image digest as live, 127.0.0.1:18855) with workflows 01-09, 21, 23, 24 imported after `sed 's/:18767/:18851/g'`; private composition harness `.scratch/verification/private-harness.ts` (real `createLiveServer` + `createPrivateOutreach` over `createDeskFixtureStore`). Evidence paths are under `.scratch/verification/`. Re-verification used fresh fixture APIs and harnesses on 18854-18861 and the outreach demo on 18871-18876, listed in the Re-verification section.

| ID  | Severity | Owner                                       | Status                                            | Title                                                                                 |
| --- | -------- | ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F1  | high     | tend-outreach                               | fixed, re-verified                                | Model draft that only repeats the contact's quote is accepted as the owner's message  |
| F2  | low      | tend-outreach                               | fixed, re-verified                                | Telegram refusals for /approve and /edit hide the rule reason                         |
| F3  | medium   | tend-lead                                   | fixed, re-verified                                | Error handler 21 keeps URLs, emails and message text; the UI says they are dropped    |
| F4  | medium   | tend-lead                                   | deferred (tend-lead, by design)                   | How it runs shows no last-run status in the real private composition                  |
| F5  | low      | tend-desk                                   | fixed, re-verified                                | How it runs omits workflows 22-26; private failure log labelled as 21                 |
| F6  | low      | tend-desk (needs a flag from tend-outreach) | fixed, re-verified                                | Desk promises a Gmail draft while `OUTREACH_ENABLED=false`                            |
| F7  | medium   | tend-lead                                   | fixed, verified from lead evidence                | `bun run integration` does not run 23/24 or force a failure into 21                   |
| F8  | medium   | tend-lead                                   | fixed, re-verified; live bot redeploy after 14:00 | Private Telegram bot cannot route /outreach /approve /edit /skip                      |
| F9  | low      | tend-desk                                   | fixed, re-verified                                | 1440 px Desk: Outreach queue squeezed into the right column                           |
| F10 | low      | tend-outreach                               | fixed, re-verified                                | `style_basis` never reaches the owner                                                 |
| F11 | low      | tend-outreach                               | mitigated; model-size limit, decision for Adam    | Local-model drafts never survive validation, so "in my style" never reaches the owner |
| F12 | low      | tend-desk                                   | fixed, re-verified                                | Approved outreach cards do not show when the 24 h approval expires                    |

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

Decision (tend-lead, about 11:12): deliberate deferral. The private API has no read path to n8n's database, so "No run data on this device" is the honest state rather than invented statuses. Brief section 5's "last-run status" stays unmet until such a read path exists; owner tend-lead.

## F5: How it runs omits 22-26; private failure log labelled as 21 (low, tend-desk)

Same steps as F4. The classroom lane lists 01-09 and 21; the private lane lists 10-20. Workflows 22 (private error handler), 23/24 (fictional outreach) and 25/26 (private outreach) are missing, though the pipeline and outreach queue depend on them. On the private page the log heading reads "Failure log · what 21 kept" while the entries come from 22.

## F6: Desk promises a Gmail draft while sending is switched off (low, tend-desk; flag from tend-outreach)

Steps: harness runs with `OUTREACH_ENABLED=false` (the default). Approve the email nudge on the Desk.
Actual: banner "Approved. Tend creates a Gmail draft; you press Send yourself." and the card says "Waiting for the Gmail step to create the draft." With the kill switch off, `approved-email` returns nothing, so no draft will ever be created and nothing tells the owner why. `OutreachService.list()` exposes no sending-enabled flag for the Desk to read.
Evidence: `screens/1440-outreach-approved-banner.jpg`.

## F7: integration does not cover outreach or a forced failure (medium, tend-lead)

`src/integration.ts` imports 26 workflows and publishes 21 but never executes 23 or 24, never forces a failure into 21 and never checks the redacted log. Brief section 7 lists all three as required integration steps. I ran them by hand (O1, O4, E1 in the feature map); E1 is how F3 was found.

Update 11:13: `src/integration.ts` now executes 23 and 24 and forces a failure into 21 (lines ~888-1020). My re-run was stopped at tend-lead's request (Docker load before the 13:00 demo); this closes from tend-lead's own recorded integration evidence, or my re-run after 14:00.

Closed 11:30: tend-lead's run on improve/lead c6200d3, committed as f827987, passes 23/23 checks in `evidence/runtime-checks.json`, including "Published error workflow 21" (forced production failure, message withheld) and "Outreach planner, Telegram approval and mock Gmail draft" (23 → native /outreach /edit /approve /skip → 24 → one mock Gmail draft, rerun proposes nothing). Read from the committed file (`cmd/lead-integration-f827987.txt`); the verifier did not rerun it because Docker is held for the demo, but ran the same steps by hand earlier (E1, O4).

## F8: private Telegram bot cannot route outreach commands (medium, tend-lead)

From `docs/plans/outreach-status.md` "Pending 1", confirmed in code: `PostgresStore.command` has no `commandExtension`, so on the private lane /outreach /approve /edit /skip never reach the outreach book. Brief section 6 requires approval from Telegram as well as the Desk. Fictional lane works (O5).

Update 11:17: fixed on improve/lead 14b46f8, checked in a clean detached checkout (`.scratch/verification/lead-checkout`): `createPrivateOutreach` registers a transaction-scoped `setCommandExtension` on `PostgresStore`; the live guard is derived from the fictional one, which forwards outreach|approve|edit|skip; 53 Docker-free outreach and Telegram tests pass. Not yet run by the verifier: `tests/live-store-parity.test.ts` "routes the private bot's outreach commands..." (Docker PostgreSQL, held at tend-lead's request until after the demo). The deployed bot changes only when workflow 14 is redeployed after 14:00 (tend-lead).

Update 11:27: tend-lead reports `tests/live-store-parity.test.ts` 20/20 against Docker PostgreSQL at 11:15 (their run, not observed by the verifier). improve/lead now contains 14b46f8, bf2e826 and 54d587d (`git merge-base --is-ancestor` checked); merged into improve/verify cleanly (44eb522), where 185 Docker-free Desk, outreach, Telegram, private-web and redaction tests pass (`cmd/unit-merged-44eb522.txt`). Verifier rerun at 11:32 on 2bbd7bb (improve/lead 450591f merged): `tests/live-store-parity.test.ts` 20/20 against Docker PostgreSQL, including "routes the private bot's outreach commands through the outreach book" (`cmd/live-store-parity.txt`). The deployed bot changes only when workflow 14 is redeployed after 14:00 (tend-lead).

## F9: Outreach queue squeezed into the right column at 1440 px (low, tend-desk)

At 1440 px the Outreach queue sits under "Before you meet" in a ~340 px column. With four drafts the page scrolls for several screens with the left three columns empty. Evidence: `screens/1440-outreach-whatsapp-approved.jpg`.

## F10: `style_basis` never reaches the owner (low, tend-outreach)

Items returned by `/api/outreach`, `/private/api/outreach` and Telegram /outreach have no `style_basis` field; it appears only in the ledger. The owner cannot tell whether a draft follows their style for that contact (brief section 6).

## F11: local-model drafts never survive validation (low, tend-outreach)

Steps: three live planner runs with real qwen3:0.6b (workflow 23 on fixture 18851 and 18861, `src/outreach-demo.ts plan` on 18871).
Actual: 12 of 12 model drafts after the F1 fix were rejected (in the first run, before the fix, 2 echoes were accepted, see F1): one echo, eleven `uncited detail: 2026-10-16`. That date is in the only style example, the owner's sent message g2 ("I will review your demo by 2026-10-16."), and the model copies it into drafts whose evidence does not contain it. The fallback is safe (templates kept), but the "draft in my style" path never produces a draft the owner sees. Possible directions: strip dates, numbers and links from style examples before prompting, or pass only style examples without such details.
Evidence: `cmd/ledger-after-24.json`, `cmd/n8n-23-18861.log`, `cmd/outreach-demo-run.txt`.

Re-check 11:14 on bf2e826 (two fresh demo servers, 18873 and 18875, real qwen3:0.6b): the uncited-date rejections are gone (style examples are scrubbed, dates become "soon"). 8 of 8 model drafts were still rejected: 6 "model repeated the prompt" (the model copied the scrubbed example or the purpose text, now caught by bf2e826), 2 "model repeated the cited message". Templates kept every time, nothing unsafe reached the owner, 156 outreach/Telegram/Desk tests pass. What remains is that qwen3:0.6b does not write an original message here; tend-outreach reports that to Adam as a model-size decision rather than loosening checks. `cmd/outreach-demo-f11.txt`.

## F12: approved cards hide the approval expiry (low, tend-desk)

Steps: harness 18859, approve the email nudge on the Desk. The API item carries `expires_at` (24 h after approval, brief section 6), and pending cards show "Approval window ends ...", but the approved card shows only the sending note, Copy text, Edit and Withdraw approval. The owner cannot see that the approval lapses tomorrow.

Re-check 11:22 on improve/desk-ui 54d587d (detached checkout `.scratch/verification/desk-checkout`, harness 18862): approving the WhatsApp draft shows "Approval ends Fri 23 Oct, 11:21", 24 h after approval; 53 Desk tests pass, including the approved-card text. `screens/1440-f12-approval-ends.jpg`. Not observed live: the "Approval window has ended" text after expiry (unit test only).

## Re-verification (22 Oct, about 11:00-11:08, merged improve/lead 03524f6)

- F1: fresh fixture API on 18861, 01-05 and 07 re-run, `/confirm`, then 23 with real qwen3:0.6b. All four drafts are messages from Adam; the four model drafts were rejected (uncited date) and templates kept. The echo rule itself is covered by `tests/outreach.test.ts` ("model repeated the cited message"), not observed live in this run. Observed live by the verifier at 11:30 with `src/outreach-demo.ts` (d1faf1b, ports 18871/18872): `O0029debd0d: template kept (model repeated the cited message)`. `cmd/outreach-demo-run.txt`. `cmd/outreach-after-23-18861.json`.
- F2: `/approve` on a skipped item → `outreach_error: "cannot approve a skipped item"`; `/edit` with a URL → the fixed uncited-detail sentence; workflow 10 renders `Outreach refused: <reason>`. `cmd/telegram-refusals-18861.txt`.
- F3: same forced failure against the new 21 → `"message": "unlisted error (text withheld)"`. `cmd/failure-log-recheck.txt`.
- F5, F6, F9: Chrome at 1440 on harness 18859: 26 workflows listed, "what 21 and 22 kept", queue full width (1376 px), "Sending is switched off" on the queue, the notice and the approved card, plus Copy text. `screens/1440-recheck-*.jpg`.
- F10: `style_basis: recipient_examples` on every item.
- 119 outreach and Telegram tests pass.

## Not findings (checked and explained)

- The unexpected "Session expired · locked" at 10:37 came from tend-desk unlocking another preview on 127.0.0.1 in the same Chrome profile (cookies are scoped by host, not port). Real use has one private API.
- The first navigation by the Chrome extension to a private page returns 403 ("requires this laptop"); a same-origin reload loads it. The extension's navigation is treated as cross-site; a typed URL is not.
- People history shows only Email and Calendar records for Mira Tan while the Desk cites LinkedIn and WhatsApp records: the fictional `exampleLivePolicy` has no social accounts, so the history API leaves those sources out. Fixture shape, not a product bug.
- /help is answered inside workflow 10's guard, so the store route returning "Command failed" for /help is expected. /setup is the private API's web setup page, not a bot command.
