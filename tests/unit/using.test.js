// Explicit resource management: the tag is async-disposable, so `await using` closes its
// connections at scope exit. The tests call the symbol method directly instead of the `using`
// syntax, because the syntax needs Node 24 and the suite runs on 22 too.

const test = require("node:test");
const assert = require("node:assert");

const { createSql } = require("../../src/index");

/**
 * A pool-shaped fake carrying its own fake Client, so the dispatcher opens no real sockets.
 *
 * @returns {any}
 */
function fakePool() {
    class Client {
        constructor() {}

        on() {}

        connect() {
            return Promise.resolve();
        }

        query(config) {
            return Promise.resolve(config);
        }

        end() {
            return Promise.resolve();
        }
    }

    return { query: (config) => Promise.resolve(config), options: {}, Client };
}

test("the tag is async-disposable, and disposing closes the pipelined connections", async () => {
    const sql = createSql(fakePool(), { pipeline: 2 });
    assert.strictEqual(typeof sql[Symbol.asyncDispose], "function");
    await sql`select 1`;
    await sql[Symbol.asyncDispose]();
    await assert.rejects(() => sql`select 1`, /closed/);
});

test("disposing a tag that opened nothing is a no-op, and the pool still answers", async () => {
    const pool = fakePool();
    const sql = createSql(pool, { pipeline: false });
    await sql[Symbol.asyncDispose]();
    // the pool is the caller's: disposal must not have touched it
    assert.deepStrictEqual(await pool.query({ text: "select 1" }), { text: "select 1" });
});
