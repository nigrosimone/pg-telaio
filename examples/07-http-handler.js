"use strict";

// The tag in an HTTP server: created once at module level, used by every request. The
// pipelining is what makes this shape pay off: concurrent requests share the same few
// connections instead of each waiting for a pool checkout.
// Run with: node examples/07-http-handler.js

const http = require("node:http");
const { Pool } = require("pg");
const { createSql } = require("../src/index.js");

// module-level singletons, like an application would have
const pool = new Pool({ connectionString: process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark" });
const sql = createSql(pool, { prepare: true });

const server = http.createServer(async (req, res) => {
    // GET /products/:id is the hot read path, straight through the tag
    const match = req.url && req.url.match(/^\/products\/(\d+)$/);
    if (req.method === "GET" && match) {
        try {
            const { rows } = await sql`select id, name, price from telaio_shop where id = ${Number(match[1])}`;
            if (rows.length === 0) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "not found" }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(rows[0]));
        } catch (err) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such route" }));
});

async function main() {
    await sql`drop table if exists telaio_shop`;
    await sql`create table telaio_shop (id serial primary key, name text, price numeric)`;
    await sql`insert into telaio_shop (name, price) values ('mouse', 12.50), ('keyboard', 45.00)`;

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    console.log("listening on http://127.0.0.1:" + port);

    // the example calls itself so it can run unattended; concurrent requests share the
    // pipelined connections
    const urls = ["/products/1", "/products/2", "/products/999"];
    const answers = await Promise.all(urls.map((u) => fetch(`http://127.0.0.1:${port}${u}`).then((r) => r.text())));
    for (let i = 0; i < urls.length; i++) {
        console.log("GET", urls[i], "->", answers[i]);
    }

    await sql`drop table telaio_shop`;
    server.close();
    await sql.close();
    await pool.end();
    console.log("closed.");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
