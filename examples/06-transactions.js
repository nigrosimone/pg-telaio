"use strict";

// The boundary: transactions go through pool.connect(), as they always did, while reads keep
// going through the tag.
//
// Why the tag never runs a transaction: a pipelined connection carries queries from several
// callers at once. A BEGIN on it would fence other people's queries into the transaction,
// and a ROLLBACK would take their writes with it. A transaction needs a connection of its
// own, and checking one out is exactly what pool.connect() is for.
// Run with: node examples/06-transactions.js

const { Pool } = require("pg");
const { createSql } = require("../src/index.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark" });
const sql = createSql(pool);

/** Moves money between two rows, atomically, on a connection of its own. */
async function transfer(from, to, amount) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        // the pure-builder shape works on the client too: sql`...` from the runner tag,
        // unawaited, is just { text, values }
        await client.query(sql.build`update telaio_accounts set balance = balance - ${amount} where id = ${from}`);
        await client.query(sql.build`update telaio_accounts set balance = balance + ${amount} where id = ${to}`);
        await client.query("commit");
    } catch (err) {
        await client.query("rollback");
        throw err;
    } finally {
        client.release();
    }
}

async function main() {
    await sql`drop table if exists telaio_accounts`;
    await sql`create table telaio_accounts (id int primary key, balance numeric not null)`;
    await sql`insert into telaio_accounts (id, balance) values (1, 100), (2, 100)`;

    // the transfer runs on its own checked-out connection while reads keep riding the
    // pipelined ones; neither waits for the other
    const [, ...reads] = await Promise.all([
        transfer(1, 2, 30),
        sql`select sum(balance)::int as total from telaio_accounts`,
        sql`select count(*)::int as n from telaio_accounts where balance > ${0}`
    ]);
    console.log("total during transfer:", reads[0].rows[0].total);
    console.log("accounts above zero:", reads[1].rows[0].n);

    const after = await sql`select id, balance::int from telaio_accounts order by id`;
    console.log("after transfer:", after.rows.map((r) => `#${r.id}=${r.balance}`).join(", "));

    await sql`drop table telaio_accounts`;
    await sql.close();
    await pool.end();
    console.log("closed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
