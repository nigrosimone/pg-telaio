"use strict";

// Quickstart: a pool, the tag on top of it, a few queries, and the close order.
// Run with: node examples/01-quickstart.js

const { Pool } = require("pg");
const { createSql } = require("../src/index.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark" });
const sql = createSql(pool);

async function main() {
    console.log("pipelined connections next to the pool:", sql.pipelining);

    // a scratch table so the example carries its own data
    await sql`drop table if exists telaio_quickstart`;
    await sql`create table telaio_quickstart (id serial primary key, name text, price numeric)`;
    await sql`insert into telaio_quickstart (name, price) values ('mouse', 12.50), ('keyboard', 45.00), ('screen', 180.00)`;

    // values become $n parameters, never string concatenation
    const name = "keyboard";
    const { rows } = await sql`select id, name, price from telaio_quickstart where name = ${name}`;
    console.log("one row:", rows[0]);

    // independent queries can just be fired together: they ride the same pipelined
    // connections instead of waiting for a pool checkout each
    const [cheap, count] = await Promise.all([
        sql`select name from telaio_quickstart where price < ${50} order by price`,
        sql`select count(*)::int as n from telaio_quickstart`
    ]);
    console.log("under 50:", cheap.rows.map((r) => r.name).join(", "));
    console.log("rows:", count.rows[0].n);

    await sql`drop table telaio_quickstart`;

    // close order: first the tag's own connections, then the pool. The tag never ends
    // the pool, it is the application's.
    await sql.close();
    await pool.end();
    console.log("closed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
