# Search evaluation on live data (22 Oct 2026, 17:18-17:36)

Read-only, on Adam's private workspace at 127.0.0.1:18768 (private API `b2b71d3`), through the page's own `POST /private/api/search` with its CSRF header. 135 requests in total. Only numbers, record-key prefixes (first 12 hex characters) and verdicts are recorded here; no message text. Index state at 17:15 (from the operator): 33,832 records complete, 3,496 pending, 5 withdrawn, 110,837 chunks.

## Method

- Sample: 59 records stratified by source (Gmail 14, Calendar 11, WhatsApp personal 14, WhatsApp business 14, LinkedIn 6), drawn with a fixed seed from the history of the most active contacts per source (`/private/api/contacts`, `/private/api/history`). Calendar had only 11 distinct titles long enough to query.
- Keyword query per record: the 2-3 rarest words of 4+ letters in that record, by document frequency over the ~480 loaded records (stop words removed).
- Semantic paraphrase per record: written by the verifier, sharing none of the record's chosen distinctive words (checked in the page; 4 of 59 paraphrases shared one, records 25, 37, 38 and 39, none of them in the semantic subset).
- Scoring: rank of the source `record_key` in the returned list (strict), and duplicate-aware rank (a result whose normalized text equals the source record also counts; the inbox contains repeated newsletters and repeated group announcements).
- Semantic mode was stopped after 6 of the planned 10 paraphrases and 2 of the planned 4 owner questions: each query took 34-160 s and latency was rising, which added load to the live system.

## 1. Self-supervised recall

### Keyword mode, keyword query (59 records)

| Slice                            | n   | hit@1    | hit@5    | hit@10   | MRR           |
| -------------------------------- | --- | -------- | -------- | -------- | ------------- |
| All, strict                      | 59  | 45 (76%) | 56 (95%) | 56 (95%) | 0.853         |
| All, duplicate-aware             | 59  | 54 (92%) | 57 (97%) | 57 (97%) | 0.938         |
| Gmail                            | 14  | 14       | 14       | 14       | 1.000         |
| Calendar                         | 11  | 8        | 9        | 9        | 0.758         |
| WhatsApp personal (strict / dup) | 14  | 10 / 13  | 14 / 14  | 14 / 14  | 0.857 / 0.964 |
| WhatsApp business (strict / dup) | 14  | 8 / 14   | 13 / 14  | 13 / 14  | 0.750 / 1.000 |
| LinkedIn                         | 6   | 5        | 6        | 6        | 0.917         |

Latency over the 59 queries: median 249 ms, p95 3,222 ms. Across every keyword call in this run (including owner questions and probes): 0.2 s to 21.7 s.

Misses (strict): records 22 and 23 (Calendar `e00a9d084a6f`, `48b34fcd5de3`) and 40 (WhatsApp business `1593d1800637`, duplicate-aware hit at 1). All three queries returned a full page of 10: results are ordered by date and capped at 10 with no next page, so an older exact match falls off the page.

### Semantic mode

| Query                                                                                 | n   | hit@1 | hit@5 | hit@10 | MRR   | Results returned   |
| ------------------------------------------------------------------------------------- | --- | ----- | ----- | ------ | ----- | ------------------ |
| Paraphrase (records 0, 1, 2, 14, 15, 26: Gmail ×3, Calendar ×2, WhatsApp personal ×1) | 6   | 0     | 0     | 0      | 0.000 | 11, 4, 12, 6, 0, 0 |
| Keyword query in semantic mode (record 0)                                             | 1   | 0     | 1     | 1      | 0.500 | 2                  |

Semantic latency (9 calls): 33.9, 37.3, 48.6, 50.1, 65.5, 85.9, 93.3, 111.3, 160.5 s; median 65.5 s, p95 160.5 s.

## 2. Owner questions (top 5 judged)

The eight questions are anonymised in this public copy (Q1 to Q8 with a generic description); the numbers are unchanged.

| Question                          | Keyword: results, latency | Keyword: relevant in top 5                                           | Semantic                                     |
| --------------------------------- | ------------------------- | -------------------------------------------------------------------- | -------------------------------------------- |
| Q1, a test booking (3 words)      | 0, 14.7 s                 | none (but its key word alone returns 2: keyword requires every word) | not run                                      |
| Q2, a sync with a named contact   | 1, 3.0 s                  | 1 of 1                                                               | 1 result in 85.9 s, the same relevant record |
| Q3, a class presentation          | 3, 8.7 s                  | 1 of 3 (rank 1 relevant, ranks 2-3 newsletters)                      | not run                                      |
| Q4, feedback on a post            | 10, 3.2 s                 | 0 of 5 (all newsletters, newest first)                               | not run                                      |
| Q5, sponsors for a named event    | 2, 5.8 s                  | 1 relevant, 1 partly relevant                                        | not run                                      |
| Q6, a lost item (English query)   | 0, 0.2 s                  | none (the relevant messages are in French)                           | 0 results in 93.3 s                          |
| Q7, a fellowship call             | 5, 0.2 s                  | 3 of 5 (ranks 3-5; ranks 1-2 newsletters)                            | not run                                      |
| Q8, a named organisation's report | 10, 0.3 s                 | 0 of 5; the relevant WhatsApp message is at rank 10 of 10            | not run                                      |

Owner-question verdict: 2 of 8 have a relevant result at rank 1 (Q2, Q3); 5 of 8 have at least one relevant result in the top 5.

## 3. Failure modes

| Probe                                       | Mode               | Result                                                                                     |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| Empty query                                 | keyword / semantic | 400, generic "Private request could not be completed. Reload changed pages or try again."  |
| Spaces only                                 | keyword            | 400, same generic message                                                                  |
| Emoji only                                  | keyword            | 400 after 4.5 s, same generic message (the server's own "Enter search words" is not shown) |
| French (2 words)                            | keyword            | 200, 1 result, 21.7 s                                                                      |
| 400 characters                              | keyword            | 200, 5 results, 6.6 s                                                                      |
| 401 characters                              | keyword            | 400, generic message (limit is 400, not stated to the user)                                |
| 501 characters                              | semantic           | 400, generic message (limit is 500)                                                        |
| Injection-like text                         | keyword            | 200, 0 results; no change of behaviour                                                     |
| SQL-like text (`'; DROP TABLE records; --`) | keyword            | 200, 10 results matched as plain words; parameterized, harmless                            |
| Emoji, injection-like                       | semantic           | not run (stopped for latency)                                                              |

## Top 3 fixes by expected impact

1. **Make semantic search usable or hide it.** 34-160 s per query, 0 of 6 paraphrases found, and 0 results for 2 of them, with 3,496 records still pending embedding. Put a hard time budget on the query path (for example 5 s, then fall back to keyword with a notice), check that the query embedding and vector lookup do not wait behind the indexing backlog or the local model, and find why most queries return so few results (similarity threshold or unindexed chunks). Until then, default the selector to Keyword.
2. **Rank keyword results by relevance, not date.** Today every word must match, results are newest first and capped at 10 with no next page. That is why Q8 puts the right message at rank 10, Q4 returns only newsletters, and Q1 returns nothing. Score by matched terms (BM25 or a simple term count), stop requiring every word for 3+ word queries, drop stop words, down-rank bulk mail (the outreach planner's `isBulkMail` already exists), and add "More results".
3. **Say why a query is refused, and cover French.** Empty, emoji-only and over-length queries show "Reload changed pages or try again"; show "Enter search words" and the 400/500-character limit instead. English questions about French conversations (Q6) find nothing in either mode; that gap closes only when fix 1 works or with a small FR/EN synonym expansion.

## Separate finding from this run (F14)

Lock workspace under load: at 17:33 the Lock click switched the page to "Locked on this device", but the server session stayed valid (`/private/api/session` 200 at 17:35) because the logout request had not completed. `lockPrivateSession(...).catch(() => undefined)` locks the page whatever the server answers. An explicit `POST /private/api/logout` at 17:35 returned 200 and the session then answered 401. Expected: the page says the server lock failed and retries, or the session cookie is cleared client-side.
