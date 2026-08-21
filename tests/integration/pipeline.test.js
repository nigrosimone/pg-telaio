"use strict";

// Integration: the tag against the real database. The suite skips itself when the database is
// not reachable, so the rest of the tests still run on a machine without the bench container.

const test = require("node:test");
const assert = require("node:assert");
const { createSql } = require("../../src/index");
const { URL, openPool, ensureItems } = require("./helpers");

test("pipeline", async (t) => {
    const pool = await openPool();
    if (pool === null) {
        console.log("pipeline.test: no database at " + URL + ", skipping the suite");
        t.skip("database unreachable");
        return;
    }
    await ensureItems(pool);

    try {
        await t.test("a select returns rows and auto opens 3 connections", async () => {
            const sql = createSql(pool);
            try {
                assert.strictEqual(sql.pipelining, 3);
                const { rows } = await sql`select id, name from items where id = ${1}`;
                assert.strictEqual(rows.length, 1);
                assert.strictEqual(rows[0].id, 1);
                assert.strictEqual(typeof rows[0].name, "string");
            } finally {
                await sql.close();
            }
        });

        await t.test("three pg_sleep(0.15) overlap instead of queueing", async () => {
            const sql = createSql(pool);
            try {
                // warm the connections so the measure is the sleeps, not the handshakes
                await Promise.all([sql`select 1`, sql`select 1`, sql`select 1`]);
                const started = Date.now();
                await Promise.all([sql`select pg_sleep(0.15)`, sql`select pg_sleep(0.15)`, sql`select pg_sleep(0.15)`]);
                const elapsed = Date.now() - started;
                assert.ok(elapsed < 400, "three sleeps took " + elapsed + "ms, serial would be 450ms or more");
            } finally {
                await sql.close();
            }
        });

        await t.test("prepare: the same select is parsed once and keeps answering", async () => {
            // one connection, so the pg_prepared_statements check reads the same session
            const sql = createSql(pool, { prepare: true, pipeline: 1 });
            try {
                for (let i = 1; i <= 3; i++) {
                    const { rows } = await sql`select id, category from items where id = ${i}`;
                    assert.strictEqual(rows.length, 1);
                    assert.strictEqual(rows[0].id, i);
                }
                const like = "%from items where id =%";
                const check = await sql.unprepared`
                    select count(*)::int as n from pg_prepared_statements where statement like ${like}`;
                assert.strictEqual(check.rows[0].n, 1);
            } finally {
                await sql.close();
            }
        });

        await t.test("prepare: a sibling tag reuses the statement instead of preparing its own", async () => {
            // one connection, so the three calls land on the session that prepared the statement
            const sql = createSql(pool, { prepare: true, pipeline: 1 });
            try {
                // the same text through three tags, with a comment that only this test uses
                const one = await sql`select id from items where id = ${1} /* sibling probe */`;
                const two = await sql.prepared`select id from items where id = ${2} /* sibling probe */`;
                const optioned = sql.options({ prepare: true });
                const three = await optioned`select id from items where id = ${3} /* sibling probe */`;
                assert.deepStrictEqual([one.rows[0].id, two.rows[0].id, three.rows[0].id], [1, 2, 3]);

                const like = "%sibling probe%";
                const check = await sql.unprepared`
                    select count(*)::int as n, sum(generic_plans + custom_plans)::int as runs
                    from pg_prepared_statements where statement like ${like}`;
                // one statement for the three tags, and all three calls ran it
                assert.strictEqual(check.rows[0].n, 1);
                assert.strictEqual(check.rows[0].runs, 3);
            } finally {
                await sql.close();
            }
        });

        await t.test("prefix: the prepared statement carries the chosen name prefix", async () => {
            const sql = createSql(pool, { prepare: true, pipeline: 1, prefix: "myapp" });
            try {
                const { rows } = await sql`select id from items where id = ${9}`;
                assert.strictEqual(rows[0].id, 9);
                // same session as the prepare, so the catalog shows the name
                const like = "myapp\\_%";
                const check = await sql.unprepared`
                    select count(*)::int as n from pg_prepared_statements where name like ${like}`;
                assert.ok(check.rows[0].n >= 1, "no prepared statement named myapp_*");
            } finally {
                await sql.close();
            }
        });

        await t.test("helpers end to end on a scratch table", async () => {
            const sql = createSql(pool);
            try {
                await sql`drop table if exists telaio_test_helpers`;
                await sql`create table telaio_test_helpers (id serial primary key, name text not null, qty int not null)`;

                // insert from one object
                await sql`insert into telaio_test_helpers ${sql({ name: "one", qty: 1 })}`;
                // insert from a list of rows, with returning
                const ins = await sql`insert into telaio_test_helpers ${sql([
                    { name: "two", qty: 2 },
                    { name: "three", qty: 3 }
                ])} returning id, name`;
                assert.strictEqual(ins.rows.length, 2);
                assert.deepStrictEqual(
                    ins.rows.map((r) => r.name),
                    ["two", "three"]
                );

                // in-list
                const inl = await sql`select name from telaio_test_helpers where qty in ${sql([1, 3])} order by qty`;
                assert.deepStrictEqual(
                    inl.rows.map((r) => r.name),
                    ["one", "three"]
                );

                // set update
                await sql`update telaio_test_helpers set ${sql({ qty: 30 })} where name = ${"three"}`;
                const upd = await sql`select qty from telaio_test_helpers where name = ${"three"}`;
                assert.strictEqual(upd.rows[0].qty, 30);

                // identifiers, explicit and dynamic
                const idn =
                    await sql`select ${sql.ident("name")} from ${sql.ident("telaio_test_helpers")} where qty = ${30}`;
                assert.strictEqual(idn.rows[0].name, "three");
            } finally {
                await sql`drop table if exists telaio_test_helpers`.catch(() => {});
                await sql.close();
            }
        });

        await t.test("direct and unprepared both answer", async () => {
            const sql = createSql(pool);
            try {
                const d = await sql.direct`select 41 + 1 as answer`;
                assert.strictEqual(d.rows[0].answer, 42);
                const u = await sql.unprepared`select 2 as two`;
                assert.strictEqual(u.rows[0].two, 2);
            } finally {
                await sql.close();
            }
        });

        await t.test("close() ends only the tag connections, the pool stays up", async () => {
            const sql = createSql(pool);
            await sql`select 1`;
            await sql.close();
            const { rows } = await pool.query("select 3 as three");
            assert.strictEqual(rows[0].three, 3);
        });

        await t.test("pipeline: false rides the pool and still answers", async () => {
            const sql = createSql(pool, { pipeline: false });
            try {
                assert.strictEqual(sql.pipelining, 0);
                const { rows } = await sql`select id from items where id = ${5}`;
                assert.strictEqual(rows[0].id, 5);
            } finally {
                await sql.close();
            }
        });

        await t.test("a pool that says it pipelines gets no extra connections", async () => {
            // the shape pg-pool will have once it pipelines itself, see poolPipelines() in src
            const fake = { query: (config) => pool.query(config), options: { maxPipeline: 2 }, _pipeline: true };
            const sql = createSql(fake);
            assert.strictEqual(sql.pipelining, 0);
            const { rows } = await sql`select 7 as seven`;
            assert.strictEqual(rows[0].seven, 7);
        });
    } finally {
        await pool.end();
    }
});
