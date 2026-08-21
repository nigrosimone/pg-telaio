"use strict";

// Inserts and updates from objects: the column list comes from the object's keys, quoted as
// identifiers, and the values become parameters.
// Run with: node examples/05-insert-update.js

const { Pool } = require("pg");
const { createSql } = require("../src/index.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark" });
const sql = createSql(pool);

async function main() {
    await sql`drop table if exists telaio_gadgets`;
    await sql`create table telaio_gadgets (id serial primary key, name text, price numeric, attrs jsonb)`;

    // dynamic insert: sql(object) after "insert into t" becomes (columns) values ($1, ...)
    const gadget = { name: "lamp", price: 9.9 };
    await sql`insert into telaio_gadgets ${sql(gadget)}`;
    console.log("inserted:", gadget.name);

    // bulk insert with returning: one statement for the whole list, keys picked explicitly
    const batch = [
        { name: "fan", price: 19.0, stock: 4 },
        { name: "heater", price: 39.0, stock: 1 },
        { name: "kettle", price: 25.0, stock: 9 }
    ];
    const inserted = await sql`insert into telaio_gadgets ${sql.values(batch, ["name", "price"])} returning id, name`;
    console.log("bulk insert:", inserted.rows.map((r) => `${r.id}:${r.name}`).join(", "));

    // dynamic set update: sql(object) after "set" becomes "col" = $1, ...
    const patch = { price: 12.5 };
    await sql`update telaio_gadgets set ${sql(patch)} where name = ${"lamp"}`;
    console.log("updated lamp price");

    // sql.json for a jsonb column. The wrap matters for arrays: a bare JS array is sent as
    // a Postgres array, not JSON, so ["e27"] without sql.json would not land in jsonb.
    await sql`update telaio_gadgets set attrs = ${sql.json({ color: "red", sockets: ["e27"] })} where name = ${"lamp"}`;

    const { rows } = await sql`select name, price, attrs from telaio_gadgets where name = ${"lamp"}`;
    console.log("lamp now:", rows[0]);

    await sql`drop table telaio_gadgets`;
    await sql.close();
    await pool.end();
    console.log("closed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
