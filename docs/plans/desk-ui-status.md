DONE

# Commitment Desk UI (section 5), branch improve/desk-ui

Summary: the private workspace now has four views (Desk, Review one by one, People, How it runs) plus an Outreach queue on the Desk. Confirm, Not a promise and Mark done call the same store commands as Telegram (`/confirm <id> <date>`, `/dismiss <id>`, `/done <id>`). 29 new tests pass (49 with the existing client tests); the full unit suite passes except the two PostgreSQL files that cannot start `initdb` in the agent sandbox. Checked in Chrome with fictional data only, at 390 px and 1440 px.

## Commits (on top of 6740a78)

- `9b8c96d` cherry-pick of 57f295d (error workflow 21, fixture `/api/failure-log`)
- `de7a83d` cherry-pick of improve/lead 23f1868 (`/dismiss` engine command), only so the button can be tested here
- `299b242` Desk API: `GET /private/api/desk`, `POST /private/api/desk/{confirm,dismiss,done}`, `GET /private/api/runs`, outreach routes
- `61565e8` Desk, phone review and How it runs views
- `98eadd2` polish after the Chrome pass, fictional preview server
- `c2c8981` outreach service rule messages reach the owner; approved email detail line
- `eceb859`, `a2edfc1` Edit and Withdraw approval on approved drafts, with the 3-day consequence stated
- `004f102` this status file (first version)
- `cdaa49b` fixes from the fresh-context review (lock race blocker and nits, below)

## Files

New: `src/desk-model.ts` (pure grouping, held-back classifier, pipeline, runs catalog, outreach contract and validator), `src/desk-api.ts` (routes), `src/desk-client.ts` (DOM, textContent only), `src/desk-fixture.ts` (fictional Mira Tan / F17 in live record shape), `src/desk-dev-server.ts` (fictional preview), `tests/desk-model.test.ts`, `tests/desk-api.test.ts`, `tests/desk-client.test.ts`.
Changed: `src/private-web.ts` (route delegation, `Options extends DeskOptions`, body limit 16 KB for outreach edit only), `src/private-web-client.ts` (hash router, lock clears Desk, open a contact from the Desk), `web/private/*`, `tests/private-web-client.test.ts` (fake browser gained `location` and `querySelectorAll`; no assertion changed).

## What the lead wires in `src/live-api.ts` at merge

`createPrivateWebHandler` accepts three optional hooks (types in `src/desk-api.ts` / `src/desk-model.ts`):

- `failureLog: () => Promise<{workflow,node,message,execution_id}[]>`: private lane `GET /api/live/failure-log`, fictional lane fixture `/api/failure-log`. Absent or throwing: the Desk says "Failure log not connected", never "0 failures".
- `workflowRuns: () => Promise<DeskWorkflowRun[]>` (`{id, name, lane, last_status: success|error|running|unknown, last_run_at}`): absent means every workflow shows "No run data on this device". Entries with new IDs (for example 22 outreach) are appended to the lane they name.
- `outreach: DeskOutreachBackend`: pass `createPrivateOutreach(store, owner).service` from improve/outreach. Absent: every outreach route returns 404 and the Desk shows "Outreach is not enabled".

No other wiring is needed: the Desk reads `store.commitments/interactions/contacts/sourceStatus` through the existing handler, with the same `live-owner` / `live-private` principal as the existing briefing route.

## Behaviour notes

- Every Desk card shows quote, source, date (Paris) and source record ID. Pending cards need a due date (defaults to `suggested_due`) before Confirm is enabled.
- Held back: display-only regex for instruction-like text (`instructionLike` in `src/desk-model.ts`). It never changes stored data or what the AI sees; the engine has no persisted flag for this today.
- Not promises: recent non-calendar messages with no commitment, plus dismissed ones (10 shown, total counted).
- Error responses only echo fixed rule phrases from the engine and the outreach service; anything else is a generic retry message.
- Lock and session expiry empty every Desk container; the API returns 401 afterwards (checked in Chrome).
- The client loads Desk then Outreach sequentially and aborts superseded loads, so it stays under the handler's limit of 2 concurrent requests (checked in Chrome by switching views quickly).
- Differs from the canvas: the design says confirming li1 links it to g1 as one promise. The engine has no linking, so confirming li1 creates a second confirmed entry with the same words ("Owed to you · 2"). The Desk shows that honestly; linking would be an engine change.
- "Open <name>" and "Prepare for <name>" switch to People and select that contact (checked in Chrome: Mira Tan selected, history loaded, Prepare briefing enabled).
- If a commitment's source record is hidden (revoked source), its card shows the 64-character record key instead of a short ID like g1.
- A candidate extracted from instruction-like text never appears as a promise on the Desk, even if the extractor produced one.
- Approved outreach drafts offer Edit (back to pending) and Withdraw approval (two clicks; final, and the planner waits 3 days). Expired drafts offer nothing.

## Verification

- `bunx vitest run tests/desk-*.test.ts tests/private-web-client.test.ts`: 49 passed. `bun run test` after the last commit: 1263 passed, 16 skipped, same two PostgreSQL files failing.
- `VERIFY_FULL=1 .agents/verify.sh` at 10:06: typecheck, lint, exports, format, n8n runtime (18 checks), native cited AI, native generated draft and SQL schema pass. Tests: 1259 passed, 16 skipped, 2 files failed (`tests/private-postgres.test.ts`, `tests/semantic-postgres.test.ts`: `initdb` cannot create shared memory, `shmget` Operation not permitted, in the agent sandbox). Regenerated `evidence/*.json` were restored, not committed.
- Chrome, fictional preview (`DESK_DEV_PORT=18796 node --experimental-strip-types src/desk-dev-server.ts`), never 18768: confirmed li1 (moved to Owed to you), dismissed it on the phone review, approved the email draft (mock "Gmail draft created") and the WhatsApp draft (Copy text), opened How it runs and the failure log, tabbed through the Desk (visible green focus), locked. Automated scan: no text below 4.5:1 contrast in the Desk view, no element wider than the viewport.
- 1440 px: real 1440 px window. 390 px: Chrome would not shrink below 606 px and headless Chrome is blocked by the sandbox, so the body was constrained to 390 px inside the 606 px window. No CSS breakpoint lies between 390 and 606, so the same rules apply as on a phone.
- Screenshots (fictional data only): `.scratch/screens/desk/` (`390-*`, `1440-desk`, `1710-*` from the first maximized window).

## End to end on the merged stack (10:45)

`088db62` merges improve/lead (which already contains improve/outreach) into this branch. `src/desk-dev-server.ts` now serves the Desk through the production `createLiveServer` with `createPrivateOutreach` on an in-memory ledger (`OUTREACH_ENABLED=false`) and the fictional Mira Tan store. `.scratch/desk-e2e.mjs 18797` drives it with its own cookie jar: 15 of 15 checks pass. Covered: desk groups and held back; error handler connected; outreach drafts from the real planner; a placeholder draft refused with its reason; edit, then approve, then withdraw (final); a dash refused; unknown draft refused; confirm, done and a refused dismiss; both lanes on How it runs (26 workflows); 401 after logout. Approvals expire when their evidence changes, as the outreach service intends, and the Desk shows them as Expired.

`30e486a` adds workflows 22 to 26 to How it runs, with a test that fails if the catalog and `workflows/` drift apart.

Chrome note for parallel testers: session cookies are scoped by host, not port, so two previews on 127.0.0.1 in one Chrome profile log each other out. Take turns.

## Verifier findings (tend-verify, 11:15)

- F5 (How it runs missed 22 to 26; log heading said 21 only): fixed in `30e486a` before the report. Checked in Chrome: 12 classroom and 14 private workflows, heading "what 21 and 22 kept".
- F6 (approving an email promised a Gmail draft with sending off): the outreach service now returns `sending_enabled` (improve/outreach `aef8216`, merged here in `45ab491`). The Desk shows "Sending is switched off: approvals never create Gmail drafts.", gives a matching notice and detail, and offers Copy text on approved emails. With no flag it promises nothing. Checked in Chrome on the private-lane preview (`OUTREACH_ENABLED=false`).
- F9 (Outreach queue squeezed into the side column at 1440): the queue is now a full-width card grid below the Desk (4 columns at 1440, 1 column at 390). Checked in a real 390 px popup window: 3 cards, no overflow, buttons at least 44 px.

Full suite after the merge: 1313 passed, 16 skipped; only the two PostgreSQL files fail (sandbox `shmget`).

## Open items

- Cross-vendor review: `codex exec` cannot start in this sandbox ("failed to initialize in-process app-server client"). A fresh-context Claude review ran instead and returned BLOCK on one issue: an action in flight during lock re-rendered private Desk text into the hidden page. Fixed in `cdaa49b` with a regression test that fails on the old client. Its nits were also fixed: aborting superseded loads, re-enabling buttons after a failed reload, focus after actions and review steps, held-back candidates kept off promise lists, meeting times compared as instants, validated run statuses, a held-back total, expiry gating and a second click on Withdraw, and lock resetting section titles. Not done: moving focus when switching to People (the People view keeps its existing behaviour). Run `/codex:review` before merging to main.
- A stale fictional preview from my first attempt still listens on 127.0.0.1:18795 (fictional data, the sandbox would not let me signal it). Stop it with `lsof -ti tcp:18795 | xargs kill` if it is still there.
- When the lead merges, de7a83d duplicates improve/lead 23f1868; git should treat it as already applied.
