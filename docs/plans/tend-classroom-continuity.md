# Tend: free classroom continuity through 22 October

Status: prepared for Adam review. Not approved or installed. Continues production mode, existing accounts, data windows and owner-only output. No payments, new provider permissions, support messages or coursework submission.

## Findings

The current private services and reviewed published graphs are healthy. The local fictional native AI passed again on 15 October at 21:51 UTC. Docker now restarts the existing n8n container unless deliberately stopped. The other local services run as ordinary processes, Mac sleep is enabled and the free temporary Telegram tunnel can change hostname. A current healthy process is not proof of recovery after logout, sleep or restart.

The current Unipile dashboard shows five trial days remaining. Its API locks after trial without subscription. Automatic local recovery cannot extend that trial. A free extension requires separate authorization to contact support and provider agreement. Google same-account consent can issue new seven-day tokens that cover the 22 October session, but both native reconnect flows still require Adam to handle the unverified-app warning. No new token is claimed.

## Proposed implementation

1. Checkpoint the current reviewed runtime metadata, canonical PostgreSQL and encrypted n8n volume without printing credentials. Record current graphs, selected accounts, record hashes and delivery-ledger state. Preserve the known working configuration.
2. Add one local recovery entry point under this repository's ignored private operator folder. It resolves the existing PostgreSQL cluster and exact socket/port, uses the installed binaries, and starts only missing owned services. Never initializes another cluster, substitutes SQLite for PostgreSQL, changes grants, recreates generic workflow identities or displaces an unrelated process occupying a port. Verify ownership, exact principal/configuration and published workflow hashes before allowing ingestion.
3. Prepare user-level LaunchAgent definitions for the existing PostgreSQL, private API, fixture API, webhook proxy, Ollama and temporary tunnel as needed. Reuse an existing service registration where present. Keep configurations and logs private; pass configuration paths, never credential values, in arguments or environment. Give recovery bounded retries and explicit failure status. Provide an equally simple disable path. Install only after this plan is approved.
4. For tunnel rotation, reuse the existing owner bot credential inside native n8n. Verify the fixed published workflow/trigger, intended local proxy and new HTTPS origin before re-registering the same webhook with its existing secret. Do not expose n8n editor/API/OAuth/private store routes. Keep uncertain sends pending for inspection and never replay deliveries automatically. Check that n8n restart does not restore an obsolete callback origin.
5. Add an on-demand preflight that reports real current provider coverage, host/tunnel health, exact graphs and pending delivery count without printing private text or credentials. During the class session, offer a scoped awake assertion tied to that session; do not disable system sleep permanently or keep the laptop awake for a week.
6. Prove controlled recovery with one service at a time after draining active imports. Verify unchanged principal, source windows/cursors and obligations; no duplicate owner delivery; successful fresh native local-model execution. Test the Telegram route privately with Adam's owner command. If a provider is expired, show it unavailable/stale and use the labelled local fictional native demo. Never describe retained records as continuing synchronization.
7. Run the project verification gate and fresh independent/cross-vendor review for authored recovery code. Update only existing private guides from actual receipts. Keep the public source freeze and release unchanged unless executable public source is deliberately revised and reverified. Submit nothing.

## Gates outside local recovery

Adam handles Google warnings/consent; both newly saved connections must then pass native read and renewal checks. Unipile must grant any requested free extension; no paid fallback is authorized. Teacher validates the declared scope and fictional fallback. The laptop must have power and a working network during class. None of these can be replaced by a claim of guaranteed uptime.
