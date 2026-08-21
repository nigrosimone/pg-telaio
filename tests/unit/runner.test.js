// The runner over a fake pool: what createSql sends through pool.query and when. pipeline:false
// keeps the dispatcher out of the way; the one routing test hands the pool a fake Client instead,
// so no database is touched anywhere here.

const test = require("node:test");
const assert = require("node:assert");

const { createSql, sql } = require("../../src/index.js");

function fakePool() {
    const calls = [];
    return {
        calls,
        options: {},
        query: async (cfg) => {
            calls.push(cfg);
            return cfg;
        }
    };
}

test("prepare:true sends a statement name with the query", async () => {
    const pool = fakePool();
    const tag = createSql(pool, { pipeline: false, prepare: true });
    const got = await tag`select name from items where id = ${1} /* runner-prepare */`;
    assert.strictEqual(got.text, "select name from items where id = $1 /* runner-prepare */");
    assert.deepStrictEqual(got.values, [1]);
    assert.match(got.name, /^telaio_\d+$/);
});

test("the unprepared getter drops the name", async () => {
    const pool = fakePool();
    const tag = createSql(pool, { pipeline: false, prepare: true });
    const got = await tag.unprepared`select name from items where id = ${2}`;
    // exactly text and values, no name key at all
    assert.deepStrictEqual(got, { text: "select name from items where id = $1", values: [2] });
});

test("the siblings can be destructured off the tag", async () => {
    const pool = fakePool();
    const tag = createSql(pool, { pipeline: false, prepare: true });
    const { unprepared, prepared } = tag;

    const u = await unprepared`select id from items /* runner-destructured */`;
    assert.strictEqual(u.name, undefined);

    const p = await prepared`select id from items /* runner-destructured */`;
    assert.match(p.name, /^telaio_\d+$/);
});

test("options() combines the overrides and the getters mirror it", async () => {
    const pool = fakePool();
    const tag = createSql(pool, { pipeline: false });

    const prepared = await tag.options({ prepare: true })`select id from items /* runner-options */`;
    assert.match(prepared.name, /^telaio_\d+$/);

    const viaGetter = await tag.prepared`select id from items /* runner-options */`;
    assert.strictEqual(viaGetter.name, prepared.name);

    const back = await tag
        .options({ prepare: true })
        .options({ prepare: false })`select id from items /* runner-options */`;
    assert.strictEqual(back.name, undefined);

    const both = await tag.options({ prepare: true, pipeline: false })`select id from items /* runner-options */`;
    assert.match(both.name, /^telaio_\d+$/);
    assert.strictEqual(pool.calls.length, 4);
});

test("direct routes past the dispatcher to the pool", async () => {
    const clientConfigs = [];
    class FakeClient {
        constructor(config) {
            clientConfigs.push(config);
        }

        on() {}

        async connect() {}

        async query(cfg) {
            return { route: "dispatcher", cfg };
        }

        async end() {}
    }
    const pool = { options: {}, Client: FakeClient, query: async (cfg) => ({ route: "pool", cfg }) };
    const tag = createSql(pool, { pipeline: 2 });
    assert.strictEqual(tag.pipelining, 2);
    // the dispatcher's own clients are asked to pipeline
    assert.strictEqual(clientConfigs[0].pipeline, true);

    const piped = await tag`select 1`;
    assert.strictEqual(piped.route, "dispatcher");

    const direct = await tag.direct`select 1`;
    assert.strictEqual(direct.route, "pool");

    await tag.close();
});

test("a pipelined connection that stops answering stops receiving queries", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let queries = 0;
    class FakeClient {
        on() {}

        async connect() {}

        query(cfg) {
            queries++;
            return queries === 1 ? gate : Promise.resolve({ route: "dispatcher", cfg });
        }

        async end() {}
    }
    const pool = { options: {}, Client: FakeClient, query: async (cfg) => ({ route: "pool", cfg }) };
    const tag = createSql(pool, { pipeline: 1, stallMillis: 10 });

    // .then() is what sends it: a tag call on its own is a fragment and runs nothing
    const slow = tag`select from the one connection, and never answer`.then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // the only connection is stuck behind the slow query: this one takes the pool instead of
    // queueing behind a reply that is not coming
    const fast = await tag`select 1`;
    assert.strictEqual(fast.route, "pool");

    release({ route: "dispatcher" });
    await slow;
    await tag.close();
});

test("pipeline:false opens nothing and everything rides pool.query", async () => {
    const pool = fakePool();
    const tag = createSql(pool, { pipeline: false });
    assert.strictEqual(tag.pipelining, 0);
    await tag`select 1`;
    assert.strictEqual(pool.calls.length, 1);
    // no dispatcher, close still resolves
    await tag.close();
});

test("a named query runs under its name and the retry falls back to an automatic one", async () => {
    const calls = [];
    const pool = {
        options: {},
        query: async (cfg) => {
            calls.push(cfg);
            if (calls.length === 1) {
                const err = /** @type {any} */ (new Error("cached plan must not change result type"));
                err.code = "0A000";
                throw err;
            }
            return cfg;
        }
    };
    const tag = createSql(pool, { pipeline: false });
    const got = await tag`select id from items /* named-retry */`.named("items");
    assert.strictEqual(calls[0].name, "items");
    // the refused chosen name is not retried: that parse would collide with the dead statement
    assert.match(got.name, /^telaio_\d+$/);
});

test("prefix names the statements and the retry keeps it", async () => {
    const calls = [];
    const pool = {
        options: {},
        query: async (cfg) => {
            calls.push(cfg);
            if (calls.length === 1) {
                const err = /** @type {any} */ (new Error("cached plan must not change result type"));
                err.code = "0A000";
                throw err;
            }
            return cfg;
        }
    };
    const tag = createSql(pool, { pipeline: false, prepare: true, prefix: "myapp" });
    const got = await tag`select id from items /* prefix-retry */`;
    assert.match(calls[0].name, /^myapp_\d+$/);
    // the retry rotated the name without losing the prefix
    assert.match(got.name, /^myapp_\d+$/);
    assert.notStrictEqual(got.name, calls[0].name);

    // the same text under the default prefix is a different entry with a different name
    const plain = createSql(pool, { pipeline: false, prepare: true });
    const other = await plain`select id from items /* prefix-retry */`;
    assert.match(other.name, /^telaio_\d+$/);
});

test("a prefix that is not a clean identifier is refused", () => {
    const pool = { options: {}, query: async (cfg) => cfg };
    for (const bad of ["1bad", "has space", "has-dash", "", 7]) {
        assert.throws(() => createSql(pool, { prefix: /** @type {any} */ (bad) }), TypeError);
    }
});

test("a prepared statement refused with a retryable code runs again under a fresh name", async () => {
    for (const code of ["0A000", "26000"]) {
        const calls = [];
        const pool = {
            options: {},
            query: async (cfg) => {
                calls.push(cfg);
                if (calls.length === 1) {
                    throw Object.assign(new Error("prepared statement refused"), { code });
                }
                return cfg;
            }
        };
        const tag = createSql(pool, { pipeline: false, prepare: true });
        const got = await tag`select price from items where category = ${code}`;
        assert.strictEqual(calls.length, 2);
        assert.match(calls[0].name, /^telaio_\d+$/);
        assert.match(calls[1].name, /^telaio_\d+$/);
        assert.notStrictEqual(calls[1].name, calls[0].name);
        assert.strictEqual(calls[1].text, calls[0].text);
        assert.strictEqual(got, calls[1]);
    }
});

test("retry:false propagates the failure instead", async () => {
    const calls = [];
    const pool = {
        options: {},
        query: async (cfg) => {
            calls.push(cfg);
            throw Object.assign(new Error("cached plan must not change result type"), { code: "0A000" });
        }
    };
    const tag = createSql(pool, { pipeline: false, prepare: true, retry: false });
    await assert.rejects(
        async () => {
            await tag`select quantity from items /* runner-noretry */`;
        },
        (err) => err.code === "0A000"
    );
    assert.strictEqual(calls.length, 1);
});

test("a non-retryable code propagates on the first failure", async () => {
    const calls = [];
    const pool = {
        options: {},
        query: async (cfg) => {
            calls.push(cfg);
            throw Object.assign(new Error('column "nope" does not exist'), { code: "42703" });
        }
    };
    const tag = createSql(pool, { pipeline: false, prepare: true });
    await assert.rejects(
        async () => {
            await tag`select nope from items /* runner-42703 */`;
        },
        (err) => err.code === "42703"
    );
    assert.strictEqual(calls.length, 1);
});

test("a query awaited twice executes once", async () => {
    const pool = fakePool();
    const tag = createSql(pool, { pipeline: false });
    const q = tag`select count(*) from items /* runner-twice */`;
    const first = await q;
    const second = await q;
    assert.strictEqual(pool.calls.length, 1);
    assert.strictEqual(first, second);
});

test("createSql without a usable pool throws a TypeError", () => {
    assert.throws(() => createSql(null), TypeError);
    assert.throws(() => createSql({}), TypeError);
});

test("auto opens nothing when the pool pipelines by itself", async () => {
    const calls = [];
    const pool = {
        options: { maxPipeline: 2 },
        _pipeline: true,
        query: async (cfg) => {
            calls.push(cfg);
            return cfg;
        }
    };
    const tag = createSql(pool, { pipeline: "auto" });
    assert.strictEqual(tag.pipelining, 0);
    await tag`select 1`;
    assert.strictEqual(calls.length, 1);
    await tag.close();
});

test("the dispatcher gets the pool's config with its hidden secrets restored", async () => {
    const clientConfigs = [];
    class FakeClient {
        constructor(config) {
            clientConfigs.push(config);
        }

        on() {}

        async connect() {}

        async query(cfg) {
            return cfg;
        }

        async end() {}
    }
    const options = { host: "db", max: 10, min: 2, ssl: {}, Client: FakeClient };
    // pg-pool keeps password and ssl.key non-enumerable, so a plain spread drops them
    Object.defineProperty(options, "password", { value: "hunter2", enumerable: false });
    Object.defineProperty(options.ssl, "key", { value: "PEM", enumerable: false });
    const pool = { options, Client: FakeClient, query: async (cfg) => cfg };
    const tag = createSql(pool, { pipeline: 1 });
    const cfg = clientConfigs[0];
    assert.strictEqual(cfg.password, "hunter2");
    assert.strictEqual(cfg.ssl.key, "PEM");
    // pool-only settings must not reach the client
    assert.ok(!("max" in cfg));
    assert.ok(!("min" in cfg));
    assert.ok(!("Client" in cfg));
    await tag.close();
});

test("stallMillis:false turns the guard off and nothing rides the pool", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let queries = 0;
    class FakeClient {
        on() {}

        async connect() {}

        query(cfg) {
            queries++;
            return queries === 1 ? gate : Promise.resolve({ route: "dispatcher", cfg });
        }

        async end() {}
    }
    const poolCalls = [];
    // no options at all: configOf must cope with a pool that never got any
    const pool = {
        Client: FakeClient,
        query: async (cfg) => {
            poolCalls.push(cfg);
            return { route: "pool", cfg };
        }
    };
    const tag = createSql(pool, { pipeline: 1, stallMillis: false });
    const slow = tag`select from the one connection, and never answer`.then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // the guard is off: the query stays on the pipelined connection instead of overflowing
    const fast = await tag`select 1`;
    assert.strictEqual(fast.route, "dispatcher");
    assert.strictEqual(poolCalls.length, 0);
    release({ route: "dispatcher" });
    await slow;
    await tag.close();
});

test("auto is the default and opens connections while the pool cannot pipeline", async () => {
    const clientConfigs = [];
    class FakeClient {
        constructor(config) {
            clientConfigs.push(config);
        }

        on() {}

        async connect() {}

        async query(cfg) {
            return { route: "dispatcher", cfg };
        }

        async end() {}
    }
    const pool = { options: {}, Client: FakeClient, query: async (cfg) => ({ route: "pool", cfg }) };
    const tag = createSql(pool);
    assert.strictEqual(tag.pipelining, 3);
    assert.strictEqual(clientConfigs.length, 3);
    const got = await tag`select 1`;
    assert.strictEqual(got.route, "dispatcher");
    await tag.close();
});

test("the pure builder keeps prepare across a derive that does not mention it", () => {
    const q = sql.options({ prepare: true }).direct`select id from items /* runner-builder-derive */`;
    assert.match(q.name, /^telaio_\d+$/);
});
