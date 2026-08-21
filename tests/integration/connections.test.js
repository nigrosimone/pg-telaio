"use strict";

// Integration: how many connections the tag really opens, counted on the server rather than
// guessed from the code. The tag gets a pool of its own carrying a distinct application_name, so
// pg_stat_activity tells its connections apart from the probe's. The suite skips itself when the
// database is not reachable.

const test = require("node:test");
const assert = require("node:assert");
const { Pool } = require("pg");
const { createSql } = require("../../src/index");
const { URL, openPool } = require("./helpers");

/**
 * How many backends of this database carry `name` as their application_name.
 *
 * @param {any} probe the pool doing the counting, which does not carry the name
 * @param {string} name
 * @returns {Promise<number>}
 */
async function countFor(probe, name) {
    const { rows } = await probe.query(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and application_name = $1",
        [name]
    );
    return rows[0].n;
}

/**
 * The count once it reaches `want`, or the last one seen after ~2s: a backend takes a moment to
 * leave pg_stat_activity after its client closed the socket.
 *
 * @param {any} probe
 * @param {string} name
 * @param {number} want
 * @returns {Promise<number>}
 */
async function waitForCount(probe, name, want) {
    let n = await countFor(probe, name);
    for (let i = 0; i < 40 && n !== want; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        n = await countFor(probe, name);
    }
    return n;
}

/**
 * A pool nothing queries: it is only there to carry the connection config, so every backend
 * carrying this application_name was opened by the tag itself.
 *
 * @param {string} name
 * @returns {any}
 */
function ownerPool(name) {
    const pool = new Pool({ connectionString: URL, application_name: name, connectionTimeoutMillis: 2000 });
    pool.on("error", () => {});
    return pool;
}

test("connections", async (t) => {
    const probe = await openPool();
    if (probe === null) {
        console.log("connections.test: no database at " + URL + ", skipping the suite");
        t.skip("database unreachable");
        return;
    }

    try {
        await t.test("pipeline 240 opens nothing until the first query, then one at a time", async () => {
            const name = "telaio_lazy_" + process.pid;
            const owner = ownerPool(name);
            // the stall guard off: an overflow would run on the owner pool and its backend would
            // carry the same application_name, so the count could no longer be read
            const sql = createSql(owner, { pipeline: 240, stallMillis: false });
            try {
                assert.strictEqual(sql.pipelining, 240);
                assert.strictEqual(await countFor(probe, name), 0, "the tag connected before it had a query to run");

                for (let i = 0; i < 5; i++) {
                    const { rows } = await sql`select ${i}::int as i`;
                    assert.strictEqual(rows[0].i, i);
                }
                assert.strictEqual(await countFor(probe, name), 1, "sequential queries did not share one connection");

                // a burst has to overlap, so the tag grows; the cap is 240 and it must stay far
                // under it, opening only what the eight queries in flight need
                const burst = await Promise.all(
                    Array.from({ length: 8 }, (_, i) => sql`select pg_sleep(0.05), ${i}::int as i`)
                );
                assert.deepStrictEqual(
                    burst.map((r) => r.rows[0].i),
                    [0, 1, 2, 3, 4, 5, 6, 7]
                );
                const open = await countFor(probe, name);
                assert.ok(open > 1, "the burst stayed on one connection");
                assert.ok(open <= 8, "eight queries opened " + open + " connections");

                await sql.close();
                assert.strictEqual(await waitForCount(probe, name, 0), 0, "close() left connections open");
            } finally {
                await sql.close();
                await owner.end();
            }
        });

        await t.test("a queue behind maxPipeline drains and every reply finds its own caller", async () => {
            const name = "telaio_queue_" + process.pid;
            const owner = ownerPool(name);
            // one connection, two queries in flight on it: four of the six have to queue. The cap
            // itself is not observable from the server, one backend runs one query at a time
            // whatever the cap is, so what this pins is that the queue drains and the replies
            // come back correlated; dispatcher.test.js owns the cap.
            const sql = createSql(owner, { pipeline: 1, maxPipeline: 2, stallMillis: false });
            let sampling = true;
            let peak = 0;
            const sampler = (async () => {
                while (sampling) {
                    peak = Math.max(peak, await countFor(probe, name));
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
            })();
            let timer;
            const watchdog = new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error("watchdog: the queued queries never came back")), 15000);
            });
            try {
                // each query carries its own literal and its own parameter, so a reply handed to
                // the wrong caller cannot pass as that caller's answer
                const burst = Promise.all(
                    Array.from(
                        { length: 6 },
                        (_, i) =>
                            sql`select pg_sleep(0.05), ${i}::int as sent, ${"q" + i} as tag, ${i * 7}::int as mult`
                    )
                );
                const answers = await Promise.race([burst, watchdog]);
                assert.deepStrictEqual(
                    answers.map((r) => r.rows[0].sent + ":" + r.rows[0].tag + ":" + r.rows[0].mult),
                    ["0:q0:0", "1:q1:7", "2:q2:14", "3:q3:21", "4:q4:28", "5:q5:35"]
                );
                sampling = false;
                await sampler;
                assert.strictEqual(await countFor(probe, name), 1, "the tag did not keep exactly one connection");
                assert.ok(peak <= 1, "the tag had " + peak + " connections open at once, pipeline 1 allows one");
            } finally {
                clearTimeout(timer);
                sampling = false;
                await sampler;
                await sql.close();
                await owner.end();
            }
        });
    } finally {
        await probe.end();
    }
});
