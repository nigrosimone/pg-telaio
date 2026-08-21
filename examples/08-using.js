// `await using`: the tag closes its own connections at scope exit, success or throw. This is
// close() spelled by the language, so the pool is untouched as always and stays yours to end.
// The syntax needs Node 24; on older Node call sql.close() yourself, it is the same method.

const { Pool } = require("pg");
const { createSql } = require("../src/index");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark"
});

async function report() {
    await using sql = createSql(pool, { prepare: true });

    const [cheap, dear] = await Promise.all([
        sql`select count(*)::int as n from items where price < ${50}`,
        sql`select count(*)::int as n from items where price > ${400}`
    ]);
    console.log("cheap items:", cheap.rows[0].n, "- dear items:", dear.rows[0].n);
    // no close() here: leaving the scope disposes the tag, even if a query above threw
}

report()
    .then(() => pool.end())
    .then(() => console.log("done, tag disposed by the scope, pool ended by us"))
    .catch((err) => {
        console.error(err.message);
        return pool.end().then(() => process.exit(1));
    });
