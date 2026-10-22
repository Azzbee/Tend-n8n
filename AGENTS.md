# Tend n8n: project map for agents

Inactive n8n workflows and a fictional local API for Adam's No-code review. A guarded private Telegram control route is prepared; credential entry/enrollment remain human steps. Source inbox adapters remain fictional.
The global rules in `~/.codex/AGENTS.md` still apply; this file adds only what is specific to this repo.

## Layout

- `src/`: typed fixture API, evidence/state engine, export builder and runnable checks.
- `workflows/`: twenty-six inactive generated exports. Private live deployment IDs stay under ignored .scratch and must never enter public bundles.
- `fixtures/`, `schema/`, `evidence/`: fictional inputs, proposed PostgreSQL schema and observed check records.
- `Review.html`, `Specification.txt`, `Demo-guide.txt`: user review and rehearsal material.

## Commands

| Task | Command |
|---|---|
| Fast gate (what the Stop hook runs) | `.agents/verify.sh` |
| Every check, including slow ones | `VERIFY_FULL=1 .agents/verify.sh` |

## Working rules

- Every behaviour change comes with a test that fails without it. Never weaken, skip or delete a test to make a check pass.
- After importing the exports, publish workflow 21 (`n8n publish:workflow --id TendReview21`) and, on the private deployment once its Header Auth credential is bound, workflow 22: n8n only runs a published error workflow, and only for production executions.
- `.env` files are never read, printed or committed; use the `.env.example` shape.
- Plans go in `docs/plans/`, scratch output in `.scratch/` (gitignored), never the repo root.
- Before declaring done: `.agents/verify.sh` passes; for anything beyond a small fix, get a review from the other vendor (`/codex:review` in Claude Code).
