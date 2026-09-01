require('dotenv').config();
const pg = require('pg');
const N = Number(process.argv[2] ?? 50);
const url = process.argv[3] === 'direct' ? process.env.DB_URL_DIRECT : process.env.DB_URL_POOLED;

let ok = 0, fail = 0;
for (let i = 0; i < N; i++) {
  const c = new pg.Client(url);
  c.connect()
    .then(async () => { await c.query('SELECT 1'); ok++; console.log(`${i}: connected`); })
    .catch(e => { fail++; console.log(`${i}: FAILED — ${e.message.trim()}`); });
}
setTimeout(async () => {
  console.log(`\nclients: ${N} | connected: ${ok} | failed: ${fail}`);
  try {
    const m = new pg.Client(url);
    await m.connect();
    const r = await m.query("select count(*) from pg_stat_activity where backend_type = 'client backend'");
    console.log('SERVER-SIDE CONNECTIONS:', r.rows[0].count);
    await m.end();
  } catch (e) {
    console.log('MONITOR LOCKED OUT TOO:', e.message.trim());
  }
  process.exit(0);
}, 30000);