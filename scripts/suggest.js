// Index SUGGESTER prototype — observe → flag → propose. Never creates anything.
require('dotenv').config();
const pg = require('pg');

const url = process.env.DB_URL_POOLED || process.env.DB_URL_DIRECT;
const TOP_N = 10;                // top read queries by total time
const MIN_TOTAL_MS = 20;         // ignore trivial queries
const MIN_TABLE_ROWS = 10000;    // ignore small tables
const SAMPLES = ["'1'", "'a'"];  // naive replay for $n placeholders (NOT NULL — see README)

const client = new pg.Client({ connectionString: url });

// crude + honest: plain column names only. Deliberately fails on
// expressions like lower(handle) → routed to human review instead.
function columnsFromFilter(text) {
  const out = []; let m;
  const re = /([a-z_][a-z0-9_]*)\s*(?:=|<>|<=|>=|<|>)\s/gi;
  while ((m = re.exec(text))) if (!out.includes(m[1])) out.push(m[1]);
  return out.filter(c => !['and','or','not','null'].includes(c.toLowerCase()));
}

function walk(node, found) {
  if (!node) return found;
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) found.seqs.push(node);
  if (node['Sort Key'] && !found.sortKey) found.sortKey = node['Sort Key'];
  return (node.Plans || []).reduce((f, p) => walk(p, f), found);
}

// transaction-wrapped so SET LOCAL works even behind a transaction pooler
// (the session-state lesson from the pooling demo, applied)
async function explainAnalyze(sql) {
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const r = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
    await client.query('COMMIT');
    return r.rows[0]['QUERY PLAN'][0].Plan;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

async function explainWithReplay(queryText) {
  let last = '';
  for (const s of SAMPLES) {
    try { return { plan: await explainAnalyze(queryText.replace(/\$\d+/g, s)) }; }
    catch (e) { last = e.message.split('\n')[0]; }
  }
  return { error: last };
}

(async () => {
  await client.connect();
  const cand = await client.query(`
    SELECT query, calls, total_exec_time, mean_exec_time
    FROM pg_stat_statements
    WHERE total_exec_time > ${MIN_TOTAL_MS}
      AND lower(ltrim(query)) LIKE 'select%'
      AND query NOT LIKE '%pg_stat_statements%'   -- never analyze ourselves
      AND query NOT LIKE '%pg_class%'
    ORDER BY total_exec_time DESC LIMIT ${TOP_N}`);

  console.log(`examining top ${cand.rows.length} read queries\n`);
  const proposals = new Set();

  for (const q of cand.rows) {
    console.log(`▶ ${q.query.replace(/\s+/g, ' ').slice(0, 72)}…`);
    console.log(`   calls=${q.calls} mean=${Number(q.mean_exec_time).toFixed(1)}ms total=${Number(q.total_exec_time).toFixed(0)}ms`);

    const { plan, error } = await explainWithReplay(q.query);
    if (error) { console.log(`   SKIP — can't replay params (${error})\n`); continue; }

    const found = walk(plan, { seqs: [], sortKey: null });
    if (!found.seqs.length) { console.log('   OK — no Seq Scans\n'); continue; }

    for (const seq of found.seqs) {
      const rel = seq['Relation Name'];
      const filter = seq['Filter'];
      if (!filter) { console.log(`   IGNORE — ${rel}: full scan by design (no predicate)\n`); continue; }

      if (/lower\s*\(|upper\s*\(/i.test(filter)) {
        console.log(`   FLAG — expression predicate on ${rel}: needs an EXPRESSION index → human review\n   ${filter}\n`);
        continue;
      }

      const size = await client.query('SELECT reltuples::bigint n FROM pg_class WHERE relname=$1', [rel]);
      if (Number(size.rows[0].n) < MIN_TABLE_ROWS) { console.log(`   IGNORE — ${rel} too small\n`); continue; }

      const cols = columnsFromFilter(filter);
      if (!cols.length) { console.log(`   FLAG — complex predicate, human review: ${filter}\n`); continue; }

      let sortExpr = '';
      if (found.sortKey) {
        const first = found.sortKey[0].split(' ')[0];
        const dir = /DESC/i.test(found.sortKey.join(' ')) ? ' DESC' : '';
        if (!cols.includes(first)) sortExpr = first + dir;
      }
      const ddl = `CREATE INDEX idx_${rel}_${cols.join('_')}${sortExpr ? '_' + sortExpr.replace(' ', '_') : ''} ON ${rel} (${[...cols, sortExpr].filter(Boolean).join(', ')});`;
      console.log(`   SEQ SCAN on ${rel} — rows removed by filter: ${seq['Rows Removed by Filter'] ?? 'n/a'}`);
      console.log(`   PROPOSE → ${ddl}\n`);
      proposals.add(ddl);
    }
  }
  console.log('— — —\n' + ([...proposals].join('\n') || '(no proposals)'));
  console.log('\nThis tool never executes its proposals — write cost, locks, and selectivity are human judgment.');
  await client.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });