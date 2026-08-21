"use strict";

// The pure builder: require { sql } and there is no pool inside the library at all. The tag
// only builds, and what it builds is the { text, values } object pg accepts, so it goes
// straight to pool.query() or client.query().
// Run with: node examples/03-builder-only.js

const { Pool } = require("pg");
const { sql } = require("../src/index.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark" });

async function main() {
    // build, then hand to pg: the query object has text and values
    const query = sql`select ${21}::int * 2 as answer`;
    console.log("built:", { text: query.text, values: query.values });

    const { rows } = await pool.query(query);
    console.log("pool.query(sql`...`):", rows[0].answer);

    // the same object works on a checked-out client
    const client = await pool.connect();
    try {
        const r = await client.query(sql`select ${"hello"}::text as word`);
        console.log("client.query(sql`...`):", r.rows[0].word);
    } finally {
        client.release();
    }

    // a named one: .options({ prepare: true }).build stamps a stable name, so pg prepares it
    // once per connection and later calls skip the parse
    const named = sql.options({ prepare: true }).build`select count(*)::bigint as n from pg_class`;
    console.log("named:", { name: named.name, text: named.text });
    const n = await pool.query(named);
    console.log("rows in pg_class:", n.rows[0].n);

    // awaiting the pure builder throws: it has nothing to run on
    try {
        await sql`select 1`;
    } catch (err) {
        console.log("awaiting the builder throws:", err.message);
    }

    await pool.end();
    console.log("closed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
