// pool.query() against the tag, rounds alternated so a machine that drifts cannot decide the
// result, plus a second pool arm as the control: whatever it reports is noise.
const pg = require('pg');
const { createSql } = require('../src/index');

const URL = process.env.DATABASE_URL || 'postgres://bench:bench@localhost:5432/benchmark';
const CONNS = Number(process.env.CONNS || 3);
const INFLIGHT = Number(process.env.INFLIGHT || 64);
const SECONDS = Number(process.env.SECONDS || 3);
const ROUNDS = Number(process.env.ROUNDS || 7);
const NATIVE = process.env.NATIVE === '1';
const COLS = 'id, name, category, price, quantity, active, tags, rating_score, rating_count';
const idOf = (i) => 1 + (i % 50000);

const newPool = () => {
    const Pool = NATIVE ? pg.native.Pool : pg.Pool;
    return new Pool({ connectionString: URL, max: CONNS });
};

const poolArm = () => {
    const pool = newPool();
    return {
        q: (i) => pool.query({ name: 'read', text: `SELECT ${COLS} FROM items WHERE id = $1 LIMIT 1`, values: [idOf(i)] }),
        end: () => pool.end(),
    };
};

// same pool the application already has, the tag only adds its own connections next to it
const tagArm = () => {
    const pool = newPool();
    const sql = createSql(pool, { prepare: true, pipeline: CONNS });
    return {
        q: (i) => sql`SELECT id, name, category, price, quantity, active, tags, rating_score, rating_count FROM items WHERE id = ${idOf(i)} LIMIT 1`,
        end: () => sql.close().then(() => pool.end()),
    };
};

const ARMS = [
    { name: 'pool', mk: poolArm },
    { name: 'sql tag', mk: tagArm },
    { name: 'pool-ctrl', mk: poolArm },
];

(async () => {
    const arms = ARMS.map((a) => a.mk());

    // same answer from every arm, or the comparison means nothing
    const shapes = await Promise.all(arms.map((a) => a.q(42).then((r) => JSON.stringify(r.rows[0]))));
    if (new Set(shapes).size !== 1) throw new Error('the arms do not answer the same row');

    const out = ARMS.map(() => []);
    for (let r = 0; r < ROUNDS; r++) {
        const order = r % 2 ? [...ARMS.keys()].reverse() : [...ARMS.keys()];
        for (const i of order) {
            let n = 0, k = 0, stop = false;
            setTimeout(() => { stop = true; }, SECONDS * 1000);
            await Promise.all(Array.from({ length: INFLIGHT }, async () => {
                while (!stop) { await arms[i].q(k++); n++; }
            }));
            out[i][r] = n / SECONDS;
        }
    }

    const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };
    console.log(`primary key read, ${CONNS} connections, ${INFLIGHT} in flight, ${SECONDS}s x ${ROUNDS} rounds, ${NATIVE ? 'native' : 'js'} client`);
    // the first round is a warmup and is dropped
    ARMS.forEach((a, i) => {
        const ratio = med(out[i].slice(1).map((v, k) => v / out[0].slice(1)[k]));
        console.log(`  ${a.name.padEnd(10)} ${String(Math.round(med(out[i].slice(1)))).padStart(6)} q/s   x pool ${ratio.toFixed(3)}`);
    });
    await Promise.all(arms.map((a) => a.end()));
    process.exit(0);
})();
