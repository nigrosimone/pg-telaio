"use strict";

// Per-query opt-outs: the tag is created with prepare and pipelining on, and for one query
// you still get the plain template function without them.
// Run with: node examples/02-per-query-optout.js

const { Pool } = require("pg");
const { createSql } = require("../src/index.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark" });

// prepare and pipelining both on, which is the default
const sql = createSql(pool);

// the siblings, one option flipped each: same connections and same statement names as sql
const { unprepared, direct, options } = sql;

async function main() {
    await sql`drop table if exists telaio_optout`;
    await sql`create table telaio_optout (id serial primary key, label text)`;
    await sql`insert into telaio_optout (label) values ('a'), ('b'), ('c')`;

    // the default: named statement, pipelined connection
    const hot = await sql`select label from telaio_optout where id = ${1}`;
    console.log("default (prepared, pipelined):", hot.rows[0].label);

    // unprepared: same connections, no statement name for this one query.
    // When it matters: behind pgbouncer in transaction mode a named statement dies between
    // calls, and a one-off query is not worth a name anyway.
    const once = await unprepared`select count(*)::int as n from telaio_optout`;
    console.log("unprepared:", once.rows[0].n, "rows");

    // direct: still prepared, but rides pool.query() instead of the shared pipelined
    // connections. When it matters: replies on a pipelined connection come back in order,
    // so a slow query would hold up every reply queued behind it. Send it through the pool
    // and the hot path never sees it.
    const slow = await direct`select label, pg_sleep(0.05) from telaio_optout where id = ${2}`;
    console.log("direct:", slow.rows[0].label);

    // options(): both opt-outs at once, reusable as its own tag
    const plain = options({ prepare: false, pipeline: false });
    const both = await plain`select label from telaio_optout where id = ${3}`;
    console.log("options({ prepare: false, pipeline: false }):", both.rows[0].label);

    // the difference is visible on the built object: the tag stamps a name, the sibling does not
    console.log("name from sql.build:", sql.build`select 1`.name);
    console.log("name from unprepared.build:", unprepared.build`select 1`.name);

    await sql`drop table telaio_optout`;
    await sql.close();
    await pool.end();
    console.log("closed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
