# Which live n8n workflows fail (read-only analysis plan)

Brief section 3. Status: plan only, waiting for the sandbox to allow the Docker socket. Do not run between 12:30 and 14:00 on 22 Oct 2026.

## Why insights, not executions

The Overview reports about 8% failed production executions over 7 days. The private workflows (10 to 20) save no execution data (`saveDataErrorExecution: "none"`), so their failed runs are not kept in `execution_entity`. n8n still writes per-run counters to its insights tables, so failures can be counted per workflow without turning execution saving on. The per-workflow Insights view is paywalled, but the tables are in the database.

## Where the data is

- Container: `tend-nocode-live` (started by LaunchAgent `com.tend.classroom.docker`).
- Database: SQLite at `/home/node/.n8n/database.sqlite`, the same file the existing live audits read with `node:sqlite` in `readOnly` mode.
- Tables (n8n 2.x): `insights_metadata` (metaId, workflowId, workflowName), `insights_raw` (metaId, type, value, timestamp, not yet compacted), `insights_by_period` (metaId, type, value, periodUnit, periodStart, compacted).

## Steps (all read-only)

1. Confirm the schema and the type codes, without guessing:
   `docker exec tend-nocode-live node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/home/node/.n8n/database.sqlite',{readOnly:true});console.log(d.prepare(\"select name, sql from sqlite_master where name like 'insights%'\").all())"`
   Check the type enum against the n8n source for the running version (expected `time_saved_min`=0, `runtime_ms`=1, `success`=2, `failure`=3; verify before trusting).
2. Count successes and failures per workflow over the last 7 days, using both tables since raw rows are compacted into periods. The query returns only IDs, names and numbers, never item data:
   ```sql
   with rows as (
     select metaId, type, value, timestamp as at from insights_raw
     union all
     select metaId, type, value, periodStart as at from insights_by_period
   )
   select m.workflowId, m.workflowName,
          sum(case when r.type = 3 then r.value else 0 end) as failed,
          sum(case when r.type = 2 then r.value else 0 end) as succeeded
   from rows r join insights_metadata m on m.metaId = r.metaId
   where r.at >= datetime('now', '-7 days')
   group by m.workflowId, m.workflowName
   having failed > 0
   order by failed desc;
   ```
3. Map each workflow ID to its export (`workflows/*.json` `id`, or the private deployment IDs in the main checkout's ignored `.scratch`). Flag workflows that are not among the 21 exports (old probes and diagnostics) for the archive list in brief step 4.5.
4. For each failing workflow, find the cause without reading message content:
   - `docker logs --since 168h tend-nocode-live 2>&1 | grep -iE "error|failed" | grep -oE 'workflow(Id)?[=:" ]+[A-Za-z0-9]{1,40}|node[=:" ]+"[^"]{1,60}"' | sort | uniq -c`. This keeps only workflow IDs, node names and counts: n8n error lines can quote provider responses (message snippets, names, addresses), and cutting them to 200 characters does not redact them. Never save the raw log lines.
   - Read the workflow design and the guard code in `src/build-workflows.ts` to tell real bugs from deliberate rejections (owner guard, scope guard, provider 429 retry window).
   - Reproduce a suspected bug with the fictional fixtures in the isolated integration n8n, never in the live one.
5. For each failure, decide: a bug (fix it with a test), a deliberate guard (turn it into a handled branch if it should not count as a failure), or by design (document why it stays a failure).

## Guardrails

- `readOnly: true` on every open; no `UPDATE`, `DELETE`, settings change or restart of the live container.
- No execution-data saving switched on for private workflows.
- Output saved to `.scratch/n8n-failures/` holds only IDs, names, counts and messages of 200 characters or less.
