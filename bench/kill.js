// Every connection is terminated while queries are pipelined on it. The queries in flight are
// lost, and the ones after them have to go through: a dispatcher that hands them to a dead
// connection, or one that leaves the caller queued with nobody to wake it, hangs here instead.
const pg = require('pg');
const { createSql } = require('../src/index');

const URL = process.env.DATABASE_URL || 'postgres://bench:bench@localhost:5432/benchmark';
const NATIVE = process.env.NATIVE === '1';

(async () => {
    const Pool = NATIVE ? pg.native.Pool : pg.Pool;
    const pool = new Pool({ connectionString: URL, max: 2 });
    const sql = createSql(pool, { prepare: true, pipeline: 2 });
    const admin = new pg.Client({ connectionString: URL });
    await admin.connect();

    let ok = 0, failed = 0, running = true;
    const loop = async () => {
        while (running) {
            try { await sql`SELECT id FROM items WHERE id = ${7} LIMIT 1`; ok++; }
            catch (e) { failed++; }
        }
    };
    const workers = Array.from({ length: 8 }, loop);
    const watchdog = setTimeout(() => { console.log('WEDGED: the event loop stopped running'); process.exit(2); }, 20000);

    await new Promise((r) => setTimeout(r, 700));
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()");
    const okAtKill = ok, failedAtKill = failed;
    console.log(`killed every connection after ${ok} queries`);

    await new Promise((r) => setTimeout(r, 3000));
    running = false;
    await Promise.all(workers);
    clearTimeout(watchdog);
    console.log(`after: ${ok - okAtKill} ok, ${failed - failedAtKill} failed -> ${ok - okAtKill > 0 ? 'RECOVERED' : 'DID NOT RECOVER'}`);
    await admin.end();
    await sql.close();
    await pool.end();
    process.exit(0);
})();
