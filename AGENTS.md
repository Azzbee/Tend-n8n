# Tend n8n: project map for agents

One line on what this repo is and who uses it: fill this in.
The global rules in `~/.codex/AGENTS.md` still apply; this file adds only what is specific to this repo.

## Layout

- No package manifest detected at the top two levels.

## Commands

| Task | Command |
|---|---|
| Fast gate (what the Stop hook runs) | `.agents/verify.sh` |
| Every check, including slow ones | `VERIFY_FULL=1 .agents/verify.sh` |

## Working rules

- Every behaviour change comes with a test that fails without it. Never weaken, skip or delete a test to make a check pass.
- `.env` files are never read, printed or committed; use the `.env.example` shape.
- Plans go in `docs/plans/`, scratch output in `.scratch/` (gitignored), never the repo root.
- Before declaring done: `.agents/verify.sh` passes; for anything beyond a small fix, get a review from the other vendor (`/codex:review` in Claude Code).
