"use strict";

// Dynamic queries: a realistic list endpoint. Optional filters become fragments, the column
// list and the order by column come from variables, and nothing is ever concatenated into
// the SQL text.
// Run with: node examples/04-dynamic-queries.js

const { Pool } = require("pg");
const { createSql } = require("../src/index.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark" });
const sql = createSql(pool);

/**
 * What a GET /products handler would build from the query string. Every filter that is
 * present becomes an unawaited fragment; sql.join glues them with " and ".
 */
function listProducts({ category, maxPrice, activeOnly, columns = ["id", "name", "price"], orderBy = "id", desc = false }) {
    const filters = [];
    if (category !== undefined) {
        filters.push(sql`category = ${category}`);
    }
    if (maxPrice !== undefined) {
        filters.push(sql`price <= ${maxPrice}`);
    }
    if (activeOnly) {
        filters.push(sql`active`);
    }
    const where = filters.length ? sql`where ${sql.join(filters, " and ")}` : sql``;

    // sql(columns) after "select" resolves to a quoted identifier list; sql.ident quotes the
    // order by column, so a request parameter cannot inject SQL there, an unknown column
    // just errors. The direction is a fragment picked from a boolean, never user text.
    const direction = desc ? sql`desc` : sql`asc`;
    return sql`select ${sql(columns)} from telaio_products ${where} order by ${sql.ident(orderBy)} ${direction} limit 10`;
}

async function main() {
    await sql`drop table if exists telaio_products`;
    await sql`create table telaio_products (id serial primary key, name text, category text, price numeric, active bool)`;
    await sql`insert into telaio_products (name, category, price, active) values
        ('mouse', 'peripherals', 12.50, true),
        ('keyboard', 'peripherals', 45.00, true),
        ('webcam', 'peripherals', 60.00, false),
        ('screen', 'displays', 180.00, true),
        ('projector', 'displays', 420.00, false),
        ('cable', 'accessories', 4.90, true)`;

    // no filters: plain select
    const all = await listProducts({});
    console.log("all:", all.rows.length, "rows");

    // two filters, custom order
    const cheap = await listProducts({ category: "peripherals", maxPrice: 50, orderBy: "price" });
    console.log("cheap peripherals:", cheap.rows.map((r) => r.name).join(", "));

    // different columns, active only, descending
    const query = listProducts({ activeOnly: true, columns: ["name", "price"], orderBy: "price", desc: true });
    console.log("built text:", query.text);
    const active = await query;
    console.log("active by price desc:", active.rows.map((r) => `${r.name} ${r.price}`).join(", "));

    // where in: an array resolves to a parenthesised parameter list after "in"
    const some = await sql`select name from telaio_products where id in ${sql([1, 3, 5])} order by id`;
    console.log("in-list:", some.rows.map((r) => r.name).join(", "));

    await sql`drop table telaio_products`;
    await sql.close();
    await pool.end();
    console.log("closed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
