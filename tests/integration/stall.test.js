"use strict";

// Integration: the stall guard. A pipelined connection stuck behind a slow query stops taking
// new queries after stallMillis, and while every connection is in that state the queries ride
// pool.query() instead. The suite skips itself when the database is not reachable.

const test = require("node:test");
const assert = require("node:assert");
const { createSql } = require("../../src/index");
const { URL, openPool } = require("./helpers");

test("stall", async (t) => {
    const pool = await openPool();
    if (pool === null) {
        console.log("stall.test: no database at " + URL + ", skipping the suite");
        t.skip("database unreachable");
        return;
    }

    try {
        await t.test("guard on: a fast query overflows to the pool while the connection is stalled", async () => {
            // one connection, so the sleep stalls everything the tag has
            const sql = createSql(pool, { pipeline: 1, stallMillis: 50 });
            try {
                // warm the connection so the sleep does not queue behind the handshake
                await sql`select 1`;
                // a tag call is lazy: then() starts the sleep on the only connection now
                const slow = sql`select pg_sleep(1)`.then((r) => r);
                // give the guard time to see the stall: well past stallMillis, well short of the sleep
                await new Promise((resolve) => setTimeout(resolve, 150));
                const started = Date.now();
                const fast = await sql`select 2 as two`;
                const elapsed = Date.now() - started;
                assert.strictEqual(fast.rows[0].two, 2);
                assert.ok(
                    elapsed < 500,
                    "the fast query took " + elapsed + "ms, behind the sleep it would be 500ms or more"
                );
                await slow;
                // the reply landed, so the connection takes queries again
                const after = await sql`select 3 as three`;
                assert.strictEqual(after.rows[0].three, 3);
            } finally {
                await sql.close();
            }
        });

        await t.test("guard off: the same fast query is stuck behind the sleep", async () => {
            // the control for the test above: without the guard the overflow never happens
            const sql = createSql(pool, { pipeline: 1, stallMillis: false });
            try {
                await sql`select 1`;
                const slow = sql`select pg_sleep(1)`.then((r) => r);
                await new Promise((resolve) => setTimeout(resolve, 150));
                const started = Date.now();
                await sql`select 2 as two`;
                const elapsed = Date.now() - started;
                assert.ok(
                    elapsed > 500,
                    "the fast query took " + elapsed + "ms, it should wait out most of the 1s sleep"
                );
                await slow;
            } finally {
                await sql.close();
            }
        });

        await t.test("guard on: a direct slow query never blocks the pipelined connection", async () => {
            const sql = createSql(pool, { pipeline: 1, stallMillis: 50 });
            try {
                await sql`select 1`;
                // direct rides the pool from the start, so the tag connection stays free
                const slow = sql.direct`select pg_sleep(1)`.then((r) => r);
                const started = Date.now();
                const fast = await sql`select 4 as four`;
                const elapsed = Date.now() - started;
                assert.strictEqual(fast.rows[0].four, 4);
                assert.ok(elapsed < 500, "the fast query took " + elapsed + "ms, the connection should have been free");
                await slow;
            } finally {
                await sql.close();
            }
        });
    } finally {
        await pool.end();
    }
});
