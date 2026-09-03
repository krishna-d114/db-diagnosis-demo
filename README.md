# db-diagnosis-demo — slow queries & connection exhaustion, diagnosed on live Postgres

**Results in one line:** a 1M-row filtered+sorted query went from 76–146ms to ~0.2ms with one composite index; 150 concurrent clients were served through a database whose hard ceiling is 60 connections with a flat server-side footprint; and a small suggester re-proposed that same index from query statistics alone.

Built after a company building agent-run influencer marketing described two production symptoms publicly:

1. Queries are slow.
2. When database connections spike — e.g. during deploys — releases fail, or ship with reduced pool sizes.

I've never seen their production system, so this repo makes no claims about their data. It demonstrates the **mechanisms** behind both symptoms on a live Postgres, and the diagnostic-first plan I'd apply to the real thing.

**Author:** C.V Krishna Surya · 3/09/2026 · krisdevd.54@gmail.com · https://github.com/krishna-d114

---

## Assumptions (stated first, adjustable)

| # | Assumption | Why it matters |
|---|---|---|
| A1 | OLTP workload on Postgres (Supabase) | Determines tooling: EXPLAIN, pg_stat_statements, transaction-mode pooling |
| A2 | Schema/indexes haven't kept up with query-shape changes | The most common cause of gradual slowdown |
| A3 | Each app instance holds its own pool, connecting directly | Explains deploy-time exhaustion |
| A4 | Rolling deploys run old + new instances simultaneously | Temporarily doubles connection demand |
| A5 | Observability is limited today | Can't attribute blame without measurement |

## Environment

- Supabase Postgres, free tier: `max_connections = 60`, `superuser_reserved_connections = 3` (default), ~4 client slots already held by Supabase's own services
- Data (`sql/01_seed.sql`): 1,000,000 `posts`, 50,000 `creators`; engagement skewed via `random()*random()`
- RLS enabled, no policies — all access in this demo is via the table owner; the Data API is never used
- Node + `pg`; connection strings via `.env` (never committed — see `.env.example`)
- Evidence convention: one raw transcript per run under `results/`, filenames describing the finding. All numbers below are quoted from those transcripts.

### 60-second plan-reading glossary

- **Index Cond** — the plan is navigating via the index (good)
- **Filter** (+ *Rows Removed by Filter*) — rows are being read and discarded; the waste meter
- **estimated `rows=` vs actual `rows=`** — big divergence means the planner's inputs (statistics) are bad
- **Seq Scan** — reading the whole table; only a problem when a predicate filters out most rows of a large table

---

## Demo 1 — finding and killing a slow query

Query shape: newest pending posts for a campaign — filter + sort + limit. This shape appears everywhere in real products (feeds, queues, dashboards).

**Baseline — no usable index** (`results/phase3-index/baseline_run2.csv`):

- Parallel Seq Scan on `posts`, 2 workers → `Rows Removed by Filter: 499,502` × 2 ≈ 999k — touched every row to return 20
- `Sort Method: top-N heapsort Memory: 27kB` → sorting is not the bottleneck (~1,000 rows survived the filter); the scan is ~100% of the cost
- Estimate 611 vs actual ~996 — planner's inputs fine; single clean cause: no index matches this shape
- Warm runs: **76.0ms / 146.1ms** (cold cache: 1,457ms — hence ranges, not cherry-picks)

**Fix** — one composite index; column order matches the query (equality-filter columns first, sort column last, direction preserved):

```sql
CREATE INDEX idx_posts_campaign_status
ON posts (campaign_id, status, created_at DESC);
```

**After** (`results/phase3-index/after_index_run3.csv`):

- `Index Scan ... Index Cond: ((campaign_id = 7) AND (status = 'pending'))` — navigating, not filtering
- `rows=20` — the LIMIT is satisfied by walking the pre-sorted index range; work stops at 20
- The Sort node vanished entirely — the index delivers rows already ordered by `created_at DESC`
- **0.239ms / 0.182ms**

| | Baseline | After index |
|---|---|---|
| Time (warm) | 76–146ms | 0.18–0.24ms |
| Rows touched | ~1,000,000 | 20 |
| Plan | Parallel Seq Scan + Sort | Index Scan, no Sort |

**≈ 500x on medians** (≈380–730x across runs). And the gap grows with data: sequential scans scale linearly with table size, index scans logarithmically — at 100M rows this isn't 500x, it's thousands. Hardware scales linearly with spend; this index scales logarithmically with data.

---

## Demo 2 — "do you use indexes?" is the wrong question

Everyone uses indexes — ORMs auto-create primary-key indexes. The real failure mode: **an index exists, but the query's shape doesn't match its key.**

With an index on `handle` (`results/phase4-planner/`):

| Query | Plan | Rows touched | Time |
|---|---|---|---|
| `WHERE lower(handle) = 'creator_42'` | Seq Scan + Filter | 49,999 removed | 33.2ms |
| `WHERE handle = 'creator_42'` | Index Scan + Index Cond | 1 | 0.045ms |

**≈700x, same table, same index, same answer.** The only variable is how the query is written. The planner wasn't being dumb: the index is sorted by `handle`; the query asks about `lower(handle)` — a different key. It correctly refused a shortcut that doesn't apply.

Bonus finding in the same capture: the slow plan estimated `rows=250` vs `rows=1` actual. Postgres keeps statistics on columns, not expressions — on `lower(handle)` it fell back to a default guess. Estimated-vs-actual divergence is how you spot bad planner inputs. (Creating an expression index on `lower(handle)` fixes both failures: navigation and statistics.)

Table-size note: `creators` is 50k rows, so the penalty is mild here. At 50M rows the same mistake is catastrophic — table size is the multiplier on every one of these mistakes.

---

## Demo 3 — connection exhaustion vs transaction-mode pooling

The deploy story: each app instance holds its own pool of connections. During a rolling deploy, old and new instances coexist — temporarily doubling demand against a hard `max_connections`. At capacity, new instances can't authenticate → deploy fails. The common workaround (deploy with smaller pools) converts hard failure into queuing: slower for everyone, feeding the "slow queries" symptom. **The two symptoms compound.**

Usable client slots on this project: 60 (max) − 3 (superuser-reserved) − ~4 (Supabase services) = **~53**.

`scripts/hold.js` opens N clients concurrently, each runs `SELECT 1` (behind a transaction pooler an idle client occupies zero server slots — only executing queries do), holds them 30s, then a monitor client counts real client backends in `pg_stat_activity`.

**Exhaustion — direct, 75 clients** (`results/phase5-pooling/direct_75_exhausted.txt`)

```
clients: 75 | connected: 53 | failed: 22
MONITOR LOCKED OUT TOO: remaining connection slots are reserved for roles
with the SUPERUSER attribute
```

- Admission stopped at 53 — exactly the arithmetic above
- Two distinct Postgres error classes captured: `sorry, too many clients already` (regular slots gone) vs `remaining connection slots are reserved...` (Postgres holds 3 slots so an admin can always log in mid-meltdown; non-superusers are refused those too)
- The measurement probe itself was locked out — at exhaustion, even diagnosis can't get in
- (The numbered `i: connected` lines are launch order, not arrival order — 75 concurrent clients race for slots)

**Scale invariance — transaction pooler (port 6543)**

| Clients | Direct | Pooled (transaction mode) |
|---|---|---|
| 25 | 25/25 in — server count 39* | 25/25 in — 19* |
| 75 | 53/75 in, 22 refused, monitor locked out | 75/75 in — 14* |
| 150 | not re-attempted (ceiling proven at 75) | 150/150 in — 20* |

\* One footnote on the ruler: these counts use the original `count(*)` from `pg_stat_activity`, which includes ~13 internal connections (~9 background workers, which don't consume `max_connections`, plus ~4 service clients, which do). Mid-experiment the counter was improved to count only `backend_type = 'client backend'`; re-measurements with the stricter ruler are in the `*_filtered` transcripts: pooled 25→8, pooled 150→16 — still flat, still tiny. Conclusions unchanged either way.

**150 concurrent clients admitted through a database whose ceiling is 60 — server-side footprint flat from 25→150.** That flat line is the entire point: with transaction-mode pooling, instance count stops dictating database capacity.

Smaller footnotes, kept honest:
- Server-side counts jitter between runs (14–20 across the pooled ramp) because only actively-executing queries occupy slots and the pooler releases sessions asynchronously. The invariant is the flatness, not any single number.
- One pooled-25 run hit ~9 transient ECONNRESETs — a teardown race with the previous run's abrupt `process.exit()`; the 150/150 run immediately after shows the pooler itself was healthy.
- The filtered direct-25 run reads 42: 25 clients + monitor + 4 services + ~12 server sessions the pooler hadn't yet released from the run before it. Abrupt disconnects linger.

### What pooling does NOT do

Pooling changes capacity and failure mode, not throughput. If the database is CPU-saturated, pooling doesn't make queries faster — it converts "connection refused" into graceful sharing. Query speed comes from Demo-1-style work. Also, behind transaction pooling, session state (`SET`, `LISTEN/NOTIFY`, advisory locks, some prepared-statement flows) can't be relied on — so the design rule is: **request-path traffic goes through the pooler; migrations and background listeners keep direct connections** (`scripts/session_test.js` demonstrates the effect).

### Gotchas hit along the way (deploy-relevant in real life)

- The direct hostname is IPv6-only on this tier: `dig` shows no A record, only AAAA (`results/phase5-pooling/dig_ipv6_check.txt`). An IPv4-only home network gets `ENOTFOUND`; connected via an IPv6 mobile hotspot. This is why the pooler endpoint is the default recommendation in IPv4-only environments — most corporate networks, many CI runners.
- Exhaustion began at 53, not 57 — Supabase's own services hold client slots before yours do. Background workers don't count against the cap; only client backends do.

---

## Demo 4 — the suggester: automating discovery, not judgment

`scripts/suggest.js` closes the loop on Demos 1–2. It reads `pg_stat_statements` (top read queries by total time), replays normalized `$n` parameters with sample literals (`NULL` is a trap — `x = NULL` folds into a one-time-false filter and erases the scan), runs `EXPLAIN (FORMAT JSON)`, and walks the plan tree for predicated Seq Scans on tables ≥10k rows.

Result (`results/phase6-suggester/run.txt`) — top-10 candidates, of which 7 were Supabase's own internal catalog queries:

- **Proposed exactly the Demo-1 index:** `CREATE INDEX idx_posts_campaign_id_status_created_at_DESC ON posts (campaign_id, status, created_at DESC)` — same columns, order, and direction I'd chosen by hand in Demo 1
- **Flagged** the `lower(handle)` predicate → human review rather than auto-proposing (expression indexes depend on query shape — Demo 2's lesson, encoded as a rule)
- Correctly **ignored** by-design full scans (`count(*)`), small tables (`pg_type`), and unreplayable parameters (boolean literal, permission-denied function) — no garbage proposals

**It never executes its proposals.** Footnotes from the run: `rows removed: 500000` is one worker's half of a parallel scan (~999k total); the `mean=2062ms` recorded for the posts query is the single cold seeding run right after the index drop — the honest warm baseline is Demo 1's 76–146ms.

Production path for this tool: validate candidates with `hypopg` (planner tests hypothetical indexes at zero build cost), open a migration PR with before/after EXPLAIN evidence, gate the commit on a human, then verify usage and garbage-collect never-scanned indexes — every index taxes every write, forever.

---

## Honest limits

- Synthetic data, one table pair, free tier — the 1M-row scale demonstrates the mechanism, not any real production skew.
- Pooling ≠ throughput (see Demo 3).
- The counting query improved mid-experiment; the main table uses one ruler consistently, filtered re-measurements are footnoted.
- No claims about the target company's actual schema, data, or workload. This is the diagnosis *method*, reproducible end-to-end.

## What I'd do in the first 30 days

| Week | Focus | Deliverable |
|---|---|---|
| 1 | Instrument | `pg_stat_statements` review sorted by total time (a 2ms query called 10×/request outranks a 300ms one — that's the N+1 detector), `pg_stat_activity` grouped by source, baseline p95s |
| 2 | Top offenders | `EXPLAIN (ANALYZE, BUFFERS)` → classify: missing-for-this-shape index / stale stats / query shape / app-side → fix the few, with before/after evidence |
| 3 | Pooling | Request-path traffic → transaction pooler; migrations and listeners stay direct. Connection budget: steady state ≤ ~80% of capacity so deploys always have headroom |
| 4 | Deploy choreography | Drain on shutdown; readiness = "can acquire a pooled connection"; alert at 80% of budget; runbook |

Non-response is data: if pooling ships and deploy-time connection counts don't move, the exhaustion hypothesis is falsified and the next suspect (e.g. migration lock queues) gets investigated — which is why everything is measured before and after.

## Future work

Suggester next steps: in-tool `hypopg` validation, replaying real captured parameter values, periodic runs, PR-opening wrapper, and an index-usage verifier that drops never-scanned indexes. Prototyped in `scripts/suggest.js`; evidence in `results/phase6-suggester/`.

## Reproduce

1. Free Supabase project → direct + transaction-pooler URLs into `.env` (`.env.example` shows the shape)
2. Run `sql/01_seed.sql` in the SQL Editor
3. Demos 1–2: paste the queries from `sql/` into the SQL Editor; save each plan
4. Demo 3: `npm i && node scripts/hold.js 75 direct && node scripts/hold.js 75 pooled`
5. Demo 4: `node scripts/suggest.js` (after seeding stats per its header comments)
6. The direct URL may require IPv6 — see gotchas

## The ask

I'm [Your Name], [year/program] at [college], looking for an internship where I can apply this diagnostic-first approach to real production signals instead of synthetic ones. Happy to start with just the Week-1 measurement audit as a trial task. [email] · [github]