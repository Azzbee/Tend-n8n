DONE

# Commitment Desk UI (section 5), branch improve/desk-ui

Summary: the private workspace now has four views (Desk, Review one by one, People, How it runs) plus an Outreach queue on the Desk. Confirm, Not a promise and Mark done call the same store commands as Telegram (`/confirm <id> <date>`, `/dismiss <id>`, `/done <id>`). 25 new tests pass; the full unit suite passes except the two PostgreSQL files that cannot start `initdb` in the agent sandbox. Checked in Chrome with fictional data only, at 390 px and 1440 px.

## Commits (on top of 6740a78)

- `9b8c96d` cherry-pick of 57f295d (error workflow 21, fixture `/api/failure-log`)
- `de7a83d` cherry-pick of improve/lead 23f1868 (`/dismiss` engine command), only so the button can be tested here
- `299b242` Desk API: `GET /private/api/desk`, `POST /private/api/desk/{confirm,dismiss,done}`, `GET /private/api/runs`, outreach routes
- `61565e8` Desk, phone review and How it runs views
- `98eadd2` polish after the Chrome pass, fictional preview server
- `c2c8981` outreach service rule messages reach the owner; approved email detail line

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
- The client loads Desk then Outreach sequentially, so it stays under the handler's limit of 2 concurrent requests.

## Verification

- `bunx vitest run tests/desk-*.test.ts`: 25 passed.
- `VERIFY_FULL=1 .agents/verify.sh` at 10:06: typecheck, lint, exports, format, n8n runtime (18 checks), native cited AI, native generated draft and SQL schema pass. Tests: 1259 passed, 16 skipped, 2 files failed (`tests/private-postgres.test.ts`, `tests/semantic-postgres.test.ts`: `initdb` cannot create shared memory, `shmget` Operation not permitted, in the agent sandbox). Regenerated `evidence/*.json` were restored, not committed.
- Chrome, fictional preview (`DESK_DEV_PORT=18796 node --experimental-strip-types src/desk-dev-server.ts`), never 18768: confirmed li1 (moved to Owed to you), dismissed it on the phone review, approved the email draft (mock "Gmail draft created") and the WhatsApp draft (Copy text), opened How it runs and the failure log, tabbed through the Desk (visible green focus), locked. Automated scan: no text below 4.5:1 contrast in the Desk view, no element wider than the viewport.
- 1440 px: real 1440 px window. 390 px: Chrome would not shrink below 606 px and headless Chrome is blocked by the sandbox, so the body was constrained to 390 px inside the 606 px window. No CSS breakpoint lies between 390 and 606, so the same rules apply as on a phone.
- Screenshots (fictional data only): `.scratch/screens/desk/` (390-_, 1440-desk, 1710-_ from the first maximized window).

## Open items

- Cross-vendor review: `codex exec` cannot start in this sandbox ("failed to initialize in-process app-server client"). A fresh-context Claude review ran instead (see below). Run `/codex:review` before merging to main.
- A stale fictional preview from my first attempt still listens on 127.0.0.1:18795 (fictional data, the sandbox would not let me signal it). Stop it with `lsof -ti tcp:18795 | xargs kill` if it is still there.
- When the lead merges, de7a83d duplicates improve/lead 23f1868; git should treat it as already applied.
