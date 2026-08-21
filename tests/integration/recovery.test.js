"use strict";

// Integration: what happens when the server invalidates a prepared statement or kills the
// connections outright. The suite skips itself when the database is not reachable.

const test = require("node:test");
const assert = require("node:assert");
const { createSql } = require("../../src/index");
const { URL, openPool, ensureItems } = require("./helpers");

test("recovery", async (t) => {
    // the kill test terminates the pool's own backends too; the error listener
    // openPool installs on the pool is what keeps that from being fatal
    const pool = await openPool();
    if (pool === null) {
        console.log("recovery.test: no database at " + URL + ", skipping the suite");
        t.skip("database unreachable");
        return;
    }
    await ensureItems(pool);

    try {
        await t.test("a schema change retries the prepared statement under a fresh name", async () => {
            // one connection, so the second select hits the session that prepared the first
            const sql = createSql(pool, { prepare: true, pipeline: 1 });
            try {
                await sql.unprepared`drop table if exists telaio_test_retry`;
                await sql.unprepared`create table telaio_test_retry (id int primary key, v int)`;
                await sql.unprepared`insert into telaio_test_retry values (${1}, ${42})`;

                const before = await sql`select v from telaio_test_retry where id = ${1}`;
                assert.strictEqual(before.rows[0].v, 42);

                await sql.unprepared`alter table telaio_test_retry alter column v type text`;

                // the cached plan now has the wrong result type; the tag retries once, renamed
                const after = await sql`select v from telaio_test_retry where id = ${1}`;
                assert.strictEqual(after.rows[0].v, "42");
            } finally {
                await sql.unprepared`drop table if exists telaio_test_retry`.catch(() => {});
                await sql.close();
            }
        });

        await t.test("retry: false surfaces the 0A000 instead", async () => {
            const sql = createSql(pool, { prepare: true, retry: false, pipeline: 1 });
            try {
                await sql.unprepared`drop table if exists telaio_test_noretry`;
                await sql.unprepared`create table telaio_test_noretry (id int primary key, v int)`;
                await sql.unprepared`insert into telaio_test_noretry values (${1}, ${7})`;

                const before = await sql`select v from telaio_test_noretry where id = ${1}`;
                assert.strictEqual(before.rows[0].v, 7);

                await sql.unprepared`alter table telaio_test_noretry alter column v type text`;

                await assert.rejects(
                    async () => {
                        await sql`select v from telaio_test_noretry where id = ${1}`;
                    },
                    (err) => err.code === "0A000"
                );
            } finally {
                await sql.unprepared`drop table if exists telaio_test_noretry`.catch(() => {});
                await sql.close();
            }
        });

        await t.test("a schema change is survived with other queries in flight on the connections", async () => {
            // three connections and four workers, so the alter lands while queries are already on
            // the wire; the stall guard is off so a slow moment cannot move them to the pool
            const sql = createSql(pool, { prepare: true, pipeline: 3, stallMillis: false });
            let stop = false;
            let ints = 0;
            let texts = 0;
            const wrong = [];
            const failures = [];

            // each worker asks a question only it can be answered with: `who` comes back from
            // its own parameter, so a reply delivered to the wrong caller shows up as a mismatch
            // instead of passing for a right answer
            const worker = async (who) => {
                let sent = 0;
                // bounded: a retry that never recovers must fail an assertion, not spin until
                // the heap gives out
                while (!stop && sent < 400) {
                    sent++;
                    try {
                        const { rows } =
                            await sql`select ${who}::int as who, v from telaio_test_inflight where id = ${1}`;
                        if (rows[0].who !== who) {
                            wrong.push(who + " got " + rows[0].who);
                            continue;
                        }
                        const v = rows[0].v;
                        if (v === 42) {
                            ints++;
                        } else if (v === "42") {
                            texts++;
                        } else {
                            // neither the old type nor the new one: a reply from another query
                            wrong.push(who + " got v " + v);
                        }
                    } catch (err) {
                        failures.push(err);
                    }
                }
            };

            const main = async () => {
                const workers = [];
                for (let i = 0; i < 4; i++) {
                    workers.push(worker(i));
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
                // the alter runs on the pool, so it is concurrent with the pipelined stream
                await pool.query("alter table telaio_test_inflight alter column v type text");
                await new Promise((resolve) => setTimeout(resolve, 400));
                stop = true;
                await Promise.all(workers);
            };

            let timer;
            const watchdog = new Promise((resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error("watchdog: the workers hung for 15s around the alter")),
                    15000
                );
            });
            try {
                await pool.query("drop table if exists telaio_test_inflight");
                await pool.query("create table telaio_test_inflight (id int primary key, v int)");
                await pool.query("insert into telaio_test_inflight values (1, 42)");
                await Promise.race([main(), watchdog]);

                assert.deepStrictEqual(wrong, [], "a query got a reply that was not its own");
                // the retry is the only thing that may fail here, and only with the code it handles
                const unexpected = failures.filter((err) => err.code !== "0A000" && err.code !== "26000");
                assert.deepStrictEqual(
                    unexpected.map((err) => err.code + " " + err.message),
                    []
                );
                assert.ok(ints > 0, "no query ran before the alter");
                assert.ok(texts > 0, "every query after the alter failed (" + failures.length + " failures)");
                // a retry that gave up would leave a stream of handled codes behind it: the point
                // of the retry is that the caller does not see them
                assert.ok(
                    failures.length < ints + texts,
                    "more queries failed (" + failures.length + ") than came back (" + (ints + texts) + ")"
                );

                // and the connections are all usable afterwards, with the new type
                const after = await Promise.all(
                    Array.from({ length: 6 }, () => sql`select v from telaio_test_inflight where id = ${1}`)
                );
                assert.deepStrictEqual(
                    after.map((r) => r.rows[0].v),
                    ["42", "42", "42", "42", "42", "42"]
                );
            } finally {
                clearTimeout(timer);
                stop = true;
                await sql.close();
                await pool.query("drop table if exists telaio_test_inflight").catch(() => {});
            }
        });

        await t.test("connections killed under load keep answering after", async () => {
            const sql = createSql(pool, { prepare: true });
            let stop = false;
            let killed = false;
            let failures = 0;
            let beforeKill = 0;
            let afterKill = 0;

            const worker = async () => {
                while (!stop) {
                    try {
                        const { rows } = await sql`select id from items where id = ${7}`;
                        assert.strictEqual(rows[0].id, 7);
                        if (killed) {
                            afterKill++;
                        } else {
                            beforeKill++;
                        }
                    } catch (err) {
                        // the queries in flight when the backends die are allowed to fail, a
                        // wrong result is not: that would be replies crossed between callers
                        if (err instanceof assert.AssertionError) {
                            throw err;
                        }
                        failures++;
                    }
                }
            };

            const main = async () => {
                const workers = [];
                for (let i = 0; i < 8; i++) {
                    workers.push(worker());
                }
                await new Promise((resolve) => setTimeout(resolve, 300));
                // every backend of this database except the one running the kill
                await pool.query(
                    "select pg_terminate_backend(pid) from pg_stat_activity " +
                        "where datname = current_database() and pid <> pg_backend_pid()"
                );
                killed = true;
                await new Promise((resolve) => setTimeout(resolve, 2000));
                stop = true;
                await Promise.all(workers);
            };

            let timer;
            const watchdog = new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error("watchdog: the workers hung for 15s after the kill")), 15000);
            });
            try {
                await Promise.race([main(), watchdog]);
            } finally {
                clearTimeout(timer);
                stop = true;
                await sql.close();
            }

            assert.ok(beforeKill > 0, "no query succeeded before the kill");
            assert.ok(afterKill > 0, "no query succeeded after the kill (failures: " + failures + ")");
        });
    } finally {
        await pool.end();
    }
});
