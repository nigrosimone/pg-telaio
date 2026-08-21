// The dispatcher's failure paths, with a fake Client so no database is involved. These pin the
// review findings: a connect failure must not become an unhandled rejection, and close() must be
// terminal - no respawn, no waiter left sleeping.

const test = require("node:test");
const assert = require("node:assert");

const { createDispatcher, isConnectionError } = require("../../src/dispatcher");

/**
 * A Client whose behaviour each test scripts: connect and query resolve or reject on demand,
 * end() is counted so a leak shows up as a number.
 *
 * @param {{ connect?: () => Promise<void>, query?: (config: object) => Promise<any>, end?: () => any }} script
 * @returns {{ Client: new (config: object) => any, created: any[] }}
 */
function fakeClient(script = {}) {
    const created = [];

    class Client {
        constructor(config) {
            this.config = config;
            this.ended = 0;
            this.handlers = {};
            created.push(this);
        }

        on(event, handler) {
            // captured so a test can fire the listeners the dispatcher installs
            this.handlers[event] = handler;
        }

        connect() {
            return script.connect ? script.connect() : Promise.resolve();
        }

        query(config) {
            return script.query ? script.query(config) : Promise.resolve(config);
        }

        end() {
            this.ended++;
            return script.end ? script.end() : Promise.resolve();
        }
    }

    return { Client, created };
}

test("a connect failure is not an unhandled rejection, and the query gets the error", async () => {
    const rejections = [];
    const onUnhandled = (err) => rejections.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
        const boom = new Error("connect refused");
        const { Client } = fakeClient({ connect: () => Promise.reject(boom) });
        const dispatcher = createDispatcher(Client, {}, { connections: 3, maxPipeline: 100 });
        // a concurrent pair opens two slots, both connects fail, both queries get the error
        const q1 = assert.rejects(() => dispatcher.query({ text: "select 1" }), /connect refused/);
        const q2 = assert.rejects(() => dispatcher.query({ text: "select 2" }), /connect refused/);
        await Promise.all([q1, q2]);
        // a macrotask turn lets any unhandled rejection from the failed connects fire
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepStrictEqual(rejections, []);
        await dispatcher.close();
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("close() is terminal: later queries are refused and nothing is respawned", async () => {
    const { Client, created } = fakeClient();
    const dispatcher = createDispatcher(Client, {}, { connections: 2, maxPipeline: 100 });
    await dispatcher.query({ text: "select 1" });
    // one sequential query opens one connection; the second slot stays unused capacity
    assert.strictEqual(created.length, 1);
    await dispatcher.close();
    assert.ok(created.every((client) => client.ended >= 1));
    await assert.rejects(() => dispatcher.query({ text: "select 1" }), /closed/);
    // the refused query must not have opened a replacement connection
    assert.strictEqual(created.length, 1);
});

test("close() wakes a queued waiter, which is refused instead of sleeping forever", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const { Client } = fakeClient({ query: () => gate });
    // one connection, one query in flight allowed: the second query has to queue
    const dispatcher = createDispatcher(Client, {}, { connections: 1, maxPipeline: 1 });
    const first = dispatcher.query({ text: "one" });
    const second = dispatcher.query({ text: "two" });
    await new Promise((resolve) => setImmediate(resolve));
    const closing = dispatcher.close();
    await assert.rejects(() => second, /closed/);
    release({});
    await first;
    await closing;
});

test("close() refuses every caller queued behind maxPipeline, not only the first", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const { Client, created } = fakeClient({ query: () => gate });
    // one connection, one query in flight allowed: the other three sit in the cap's queue
    const dispatcher = createDispatcher(Client, {}, { connections: 1, maxPipeline: 1 });
    const inflight = dispatcher.query({ text: "one" });
    const queued = [
        dispatcher.query({ text: "two" }),
        dispatcher.query({ text: "three" }),
        dispatcher.query({ text: "four" })
    ];
    await new Promise((resolve) => setImmediate(resolve));
    // the handlers go on before close(), so a refusal cannot be an unhandled rejection here
    const refusals = queued.map((query) => assert.rejects(() => query, /closed/));
    const closing = dispatcher.close();
    await Promise.all(refusals);
    // the query already on the wire still gets its reply, and nothing was respawned
    release({ text: "one" });
    assert.deepStrictEqual(await inflight, { text: "one" });
    await closing;
    assert.strictEqual(created.length, 1);
});

test("connections open on demand: none at creation, one for sequential load", async () => {
    const { Client, created } = fakeClient();
    const dispatcher = createDispatcher(Client, {}, { connections: 3, maxPipeline: 100 });
    assert.strictEqual(created.length, 0);
    for (let i = 0; i < 5; i++) {
        await dispatcher.query({ text: "select " + i });
    }
    // an idle open connection beats opening another, so sequential queries share one
    assert.strictEqual(created.length, 1);
    await dispatcher.close();
});

test("a concurrent burst grows the connections to the cap and no further", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const { Client, created } = fakeClient({ query: () => gate });
    const dispatcher = createDispatcher(Client, {}, { connections: 3, maxPipeline: 100 });
    const queries = Array.from({ length: 8 }, (_, i) => dispatcher.query({ text: "select " + i }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(created.length, 3);
    release({});
    await Promise.all(queries);
    assert.strictEqual(created.length, 3);
    await dispatcher.close();
});

test("a dead slot is replaced, not counted as capacity twice: a later burst stops at the cap", async () => {
    let release;
    let gate = new Promise((resolve) => {
        release = resolve;
    });
    const { Client, created } = fakeClient({ query: () => gate });
    const dispatcher = createDispatcher(Client, {}, { connections: 3, maxPipeline: 100 });

    const first = Array.from({ length: 8 }, (_, i) => dispatcher.query({ text: "a" + i }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(created.length, 3);
    release({});
    await Promise.all(first);

    // the second connection dies while idle, the way pg reports a socket that went away
    created[1].handlers.error(new Error("server closed the connection unexpectedly"));
    gate = new Promise((resolve) => {
        release = resolve;
    });
    const second = Array.from({ length: 8 }, (_, i) => dispatcher.query({ text: "b" + i }));
    await new Promise((resolve) => setImmediate(resolve));
    // the dead slot was respawned in place: four clients ever, three of them alive
    assert.strictEqual(created.length, 4);
    assert.strictEqual(created.filter((client) => client.ended === 0).length, 3);
    release({});
    await Promise.all(second);
    await dispatcher.close();
});

test("a stall recruits an unused slot before it takes the overflow", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let queries = 0;
    const { Client, created } = fakeClient({
        query: (cfg) => {
            queries++;
            // the first query, on the first connection, never answers
            return queries === 1 ? gate : Promise.resolve({ route: "pipeline", cfg });
        }
    });
    const overflowed = [];
    const dispatcher = createDispatcher(
        Client,
        {},
        {
            connections: 2,
            maxPipeline: 100,
            stallMillis: 10,
            overflow: async (cfg) => {
                overflowed.push(cfg);
                return { route: "overflow", cfg };
            }
        }
    );
    const slow = dispatcher.query({ text: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    // the first connection is stalled, the second was never opened: open it, skip the pool
    const during = await dispatcher.query({ text: "fast" });
    assert.strictEqual(during.route, "pipeline");
    assert.strictEqual(created.length, 2);
    assert.strictEqual(overflowed.length, 0);
    release({ route: "pipeline" });
    await slow;
    await dispatcher.close();
});

test("a connection that stops answering is left alone and the queries ride the overflow", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let queries = 0;
    const { Client } = fakeClient({
        query: (cfg) => {
            queries++;
            // the first query never answers, which is what a slow query looks like from here
            return queries === 1 ? gate : Promise.resolve({ route: "pipeline", cfg });
        }
    });
    const overflowed = [];
    const dispatcher = createDispatcher(
        Client,
        {},
        {
            connections: 1,
            maxPipeline: 100,
            stallMillis: 10,
            overflow: async (cfg) => {
                overflowed.push(cfg);
                return { route: "overflow", cfg };
            }
        }
    );
    const slow = dispatcher.query({ text: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const during = await dispatcher.query({ text: "fast" });
    assert.strictEqual(during.route, "overflow");
    assert.strictEqual(overflowed.length, 1);

    // the reply lands: the connection made progress, so it takes queries again
    release({ route: "pipeline" });
    await slow;
    const after = await dispatcher.query({ text: "fast again" });
    assert.strictEqual(after.route, "pipeline");
    assert.strictEqual(overflowed.length, 1);
    await dispatcher.close();
});

test("stallMillis 0 turns the guard off and the queries keep the connection", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let queries = 0;
    const { Client } = fakeClient({
        query: (cfg) => {
            queries++;
            return queries === 1 ? gate : Promise.resolve({ route: "pipeline", cfg });
        }
    });
    const overflowed = [];
    const dispatcher = createDispatcher(
        Client,
        {},
        {
            connections: 1,
            maxPipeline: 100,
            stallMillis: 0,
            overflow: async (cfg) => {
                overflowed.push(cfg);
                return { route: "overflow", cfg };
            }
        }
    );
    const slow = dispatcher.query({ text: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const during = await dispatcher.query({ text: "fast" });
    assert.strictEqual(during.route, "pipeline");
    assert.strictEqual(overflowed.length, 0);
    release({});
    await slow;
    await dispatcher.close();
});

test("a replaced client is ended, not abandoned", async () => {
    let calls = 0;
    const { Client, created } = fakeClient({
        query: () => {
            calls++;
            // the first query kills the connection the way pg reports it, later ones work
            return calls === 1 ? Promise.reject(new Error("Connection terminated unexpectedly")) : Promise.resolve({});
        }
    });
    const dispatcher = createDispatcher(Client, {}, { connections: 1, maxPipeline: 100 });
    await assert.rejects(() => dispatcher.query({ text: "select 1" }));
    await dispatcher.query({ text: "select 1" });
    assert.strictEqual(created.length, 2);
    assert.strictEqual(created[0].ended, 1);
    await dispatcher.close();
});

test("the statement name table is LRU: a hot text survives a churn of one-off texts", () => {
    const { nameFor } = require("../../src/query");
    const hot = "select hot from t where id = $1 -- lru probe " + Date.now();
    const hotName = nameFor(hot);
    // 999 distinct texts fill the table right up to the cap
    const firstFiller = "select 0 -- lru filler " + Date.now();
    const firstFillerName = nameFor(firstFiller);
    for (let i = 1; i < 999; i++) {
        nameFor("select " + i + " -- lru filler " + Date.now());
    }
    // touching the hot text refreshes it, so the next mint evicts the oldest filler instead
    assert.strictEqual(nameFor(hot), hotName);
    nameFor("select one more -- lru filler " + Date.now());
    assert.strictEqual(nameFor(hot), hotName);
    // and the eviction really happened: the oldest filler lost its name and mints a fresh one
    assert.notStrictEqual(nameFor(firstFiller), firstFillerName);
});

test("an 'error' from the socket marks the slot dead and the next query respawns it", async () => {
    const { Client, created } = fakeClient();
    const dispatcher = createDispatcher(Client, {}, { connections: 1, maxPipeline: 100 });
    await dispatcher.query({ text: "select 1" });
    // the socket dies between queries, the way pg reports it on an idle connection
    created[0].handlers.error(new Error("server closed the connection unexpectedly"));
    const got = await dispatcher.query({ text: "select 2" });
    assert.strictEqual(got.text, "select 2");
    assert.strictEqual(created.length, 2);
    assert.strictEqual(created[0].ended, 1);
    // the replaced client's handler firing late must not kill the new slot
    created[0].handlers.error(new Error("late error from the replaced client"));
    await dispatcher.query({ text: "select 3" });
    assert.strictEqual(created.length, 2);
    await dispatcher.close();
});

test("a query over the cap queues and runs when a reply frees the slot", async () => {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let queries = 0;
    const { Client, created } = fakeClient({
        query: (cfg) => {
            queries++;
            return queries === 1 ? gate : Promise.resolve(cfg);
        }
    });
    const dispatcher = createDispatcher(Client, {}, { connections: 1, maxPipeline: 1 });
    const first = dispatcher.query({ text: "one" });
    const second = dispatcher.query({ text: "two" });
    await new Promise((resolve) => setImmediate(resolve));
    // the cap holds: the second query has not been sent yet
    assert.strictEqual(queries, 1);
    release({ text: "one" });
    assert.deepStrictEqual(await second, { text: "two" });
    await first;
    // the queued query reused the same connection, nothing was respawned
    assert.strictEqual(created.length, 1);
    await dispatcher.close();
});

test("isConnectionError reads the code and survives an error without a message", () => {
    assert.strictEqual(isConnectionError({ code: "ECONNRESET" }), true);
    assert.strictEqual(isConnectionError({ code: "42703" }), false);
    assert.strictEqual(isConnectionError(null), false);
});

test("an 'error' while the connect is still pending fails the query with the fallback error", async () => {
    let connected;
    const gate = new Promise((resolve) => {
        connected = resolve;
    });
    const { Client, created } = fakeClient({ connect: () => gate });
    const dispatcher = createDispatcher(Client, {}, { connections: 1, maxPipeline: 100 });
    const pending = dispatcher.query({ text: "select 1" });
    // the socket errors before connect settles: the slot is dead with no error stored
    created[0].handlers.error(new Error("boom"));
    connected();
    await assert.rejects(() => pending, /could not be opened/);
    await dispatcher.close();
});

test("a replaced client whose end() rejects is swallowed, not an unhandled rejection", async () => {
    const rejections = [];
    const onUnhandled = (err) => rejections.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
        let calls = 0;
        const { Client, created } = fakeClient({
            query: () => {
                calls++;
                return calls === 1
                    ? Promise.reject(new Error("Connection terminated unexpectedly"))
                    : Promise.resolve({});
            },
            end: () => Promise.reject(new Error("end failed"))
        });
        const dispatcher = createDispatcher(Client, {}, { connections: 1, maxPipeline: 100 });
        await assert.rejects(() => dispatcher.query({ text: "select 1" }));
        await dispatcher.query({ text: "select 1" });
        assert.strictEqual(created[0].ended, 1);
        await dispatcher.close();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepStrictEqual(rejections, []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("a replaced client whose end() returns nothing is left alone", async () => {
    let calls = 0;
    let ends = 0;
    const { Client, created } = fakeClient({
        query: () => {
            calls++;
            return calls === 1 ? Promise.reject(new Error("Connection terminated unexpectedly")) : Promise.resolve({});
        },
        // only the respawn's end() misbehaves; close() still needs a promise back
        end: () => (++ends === 1 ? undefined : Promise.resolve())
    });
    const dispatcher = createDispatcher(Client, {}, { connections: 1, maxPipeline: 100 });
    await assert.rejects(() => dispatcher.query({ text: "select 1" }));
    await dispatcher.query({ text: "select 1" });
    assert.strictEqual(created[0].ended, 1);
    await dispatcher.close();
});
