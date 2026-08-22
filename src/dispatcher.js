"use strict";

// The connections behind the tag while pg's own pool cannot pipeline. They are not a pool and
// are never checked out: every query goes to the connection with the fewest results still
// outstanding, which is the whole trick - `pool.query()` gives each query a connection of its
// own, so a second query never sits behind a first and pipeline mode has nothing to work with.
//
// What a shared connection costs: replies come back in the order the queries were sent, so a
// slow query holds up every reply queued behind it on its connection. The stall guard bounds
// that. A connection with queries outstanding that has not produced a reply for `stallMillis`
// is left alone until it does, and while every connection is in that state the queries ride
// `overflow` - `pool.query()` - which is slower than a free pipelined connection and much
// faster than a place in line behind the query holding it up.

// 57P01 is admin shutdown, the rest is what the two pg clients say when the socket goes away
const CONNECTION_ERROR = /terminating connection|not queryable|Connection terminated|server closed the connection/i;

/**
 * True for the errors that mean the connection is gone rather than the query being wrong.
 *
 * @param {any} err
 * @returns {boolean}
 */
function isConnectionError(err) {
    return !!err && (err.code === "ECONNRESET" || err.code === "57P01" || CONNECTION_ERROR.test(err.message || ""));
}

/**
 * Builds the dispatcher: `connections` clients in pipeline mode, a queue for the moments all of
 * them are at `maxPipeline`, and the stall guard.
 *
 * @param {new (config: object) => any} Client the pg Client class to instantiate
 * @param {object} config connection config, the pool's own with its non-enumerable secrets restored
 * @param {object} opts
 * @param {number} opts.connections how many clients it may open; they open on demand
 * @param {number} opts.maxPipeline queries in flight per client before callers queue
 * @param {number} [opts.stallMillis] how long a connection may go without a reply before new
 *   queries stop being sent to it; 0 turns the guard off
 * @param {((config: object) => Promise<any>)|null} [opts.overflow] where a query goes while every
 *   connection is stalled; without it the caller queues instead
 * @returns {{ query: (config: object) => Promise<any>, close: () => Promise<any> }}
 */
function createDispatcher(Client, config, { connections, maxPipeline, stallMillis = 0, overflow = null }) {
    // a null slot is capacity that was never asked for: nothing is opened until a query picks
    // the slot, so a tag over an idle pool costs zero connections, the way the pool itself does
    // annotated because the slots hold either a slot or nothing, and an array filled with null
    // is otherwise read as an array of null
    /** @type {any[]} */
    const slots = new Array(connections).fill(null);
    const waiters = [];
    let closed = false;

    /**
     * Opens the client for one slot, replacing whatever was there and ending the old client so
     * a half-open socket does not linger. Also the recovery path: a dead slot is respawned by
     * pick(). `ready` never rejects - a failed connect marks the slot dead and stores the error
     * for query() to throw - because a rejected promise on a slot nobody happens to pick is an
     * unhandled rejection, and with the database down at startup that took the process down
     * before a single query was asked.
     *
     * @param {number} i slot index
     */
    const spawn = (i) => {
        const previous = slots[i];
        if (previous) {
            try {
                const ending = previous.client.end();
                if (ending && typeof ending.catch === "function") {
                    ending.catch(() => {});
                }
            } catch {
                // an already-broken client may refuse end(); there is nothing left to release
            }
        }
        const client = new Client({ ...config, pipeline: true });
        const slot = {
            client,
            inflight: 0,
            // when this connection last had something to show: a reply, or the query that woke
            // it from idle. Queries outstanding and an old `progress` is a connection stuck
            // behind a slow query, which is what the guard reads.
            progress: performance.now(),
            dead: false,
            /** @type {any} */ error: null,
            ready: /** @type {Promise<any>} */ (Promise.resolve())
        };
        // an 'error' with no listener would take the process down
        client.on("error", () => {
            if (slots[i] === slot) {
                slot.dead = true;
            }
        });
        slot.ready = client.connect().then(
            () => {},
            (err) => {
                slot.dead = true;
                slot.error = err;
            }
        );
        slots[i] = slot;
    };

    /**
     * The slot with the fewest queries in flight, or null when every slot is at the cap or
     * stalled - `stalled` says which of the two, because a cap clears as soon as a reply lands
     * and a stall does not. A dead slot is replaced and considered at once - the caller awaits
     * `slot.ready` anyway. Skipping it instead meant that with every connection dead there was
     * nothing to pick, the caller queued, and nobody ever woke it up.
     *
     * An idle open connection beats opening another; anything less - every open slot busy,
     * stalled or at the cap - opens the next unused slot instead. That is how the dispatcher
     * grows to `connections` only under load, and how a stall recruits fresh capacity before
     * falling back on the overflow.
     *
     * @returns {{ slot: any|null, stalled: boolean }}
     */
    const pick = () => {
        /** @type {any} */
        let best = null;
        let stalled = false;
        let unused = -1;
        const now = performance.now();
        for (let i = 0; i < slots.length; i++) {
            if (slots[i] === null) {
                if (unused === -1) {
                    unused = i;
                }
                continue;
            }
            if (slots[i].dead) {
                // never after close(): a respawn there would open a connection nobody closes
                if (closed) {
                    continue;
                }
                spawn(i);
            }
            const slot = slots[i];
            // the stall test comes first: a slot at the cap is skipped either way, but if it is
            // also silent it is stalled, not merely busy. Testing the cap first meant the guard
            // stopped having an opinion past `connections * maxPipeline` in flight, which is
            // exactly where a blocked connection costs the most.
            const stale = stallMillis > 0 && slot.inflight > 0 && now - slot.progress > stallMillis;
            if (stale) {
                stalled = true;
                continue;
            }
            if (slot.inflight >= maxPipeline) {
                continue;
            }
            if (best === null || slot.inflight < best.inflight) {
                best = slot;
            }
        }
        if ((best === null || best.inflight > 0) && unused !== -1 && !closed) {
            spawn(unused);
            return { slot: slots[unused], stalled: false };
        }
        return { slot: best, stalled };
    };

    return {
        /**
         * Sends one query on the least-loaded connection, queueing when all are at the cap.
         *
         * @param {object} config a pg query config: text, values, possibly name
         * @returns {Promise<any>}
         */
        async query(config) {
            if (closed) {
                throw new Error("the dispatcher is closed: sql.close() was called");
            }
            let { slot, stalled } = pick();
            let confirmed = false;
            while (slot === null) {
                // a stall is not a queue that drains: what everyone would be waiting on is the
                // slow query itself, so take the pool instead of a place in that line. The clock
                // is this process's, though, and an event-loop pause silences every connection at
                // once, so the verdict is confirmed one turn later: replies delayed by a pause
                // land in that turn, a connection that is really blocked does not move.
                if (stalled && overflow) {
                    if (!confirmed) {
                        confirmed = true;
                        await new Promise((resolve) => setImmediate(resolve));
                        if (closed) {
                            throw new Error("the dispatcher is closed: sql.close() was called");
                        }
                        ({ slot, stalled } = pick());
                        continue;
                    }
                    return overflow(config);
                }
                await new Promise((resolve) => waiters.push(resolve));
                if (closed) {
                    throw new Error("the dispatcher is closed: sql.close() was called");
                }
                ({ slot, stalled } = pick());
            }
            if (slot.inflight === 0) {
                // idle: no reply is being waited on, so the stall clock starts with this query
                slot.progress = performance.now();
            }
            slot.inflight++;
            try {
                await slot.ready;
                if (slot.dead) {
                    throw slot.error || new Error("the connection could not be opened");
                }
                return await slot.client.query(config);
            } catch (err) {
                // the client does not always emit 'error' when the connection goes away, and a
                // dead client rejects at once: without this, a caller that retries spins on
                // microtasks and never lets the event loop run again
                if (isConnectionError(err)) {
                    slot.dead = true;
                }
                throw err;
            } finally {
                slot.inflight--;
                slot.progress = performance.now();
                const waiter = waiters.shift();
                if (waiter) {
                    waiter();
                }
            }
        },

        /**
         * Ends every client, for good: later queries and queued waiters are refused, and a dead
         * slot is never respawned again. Only what the dispatcher opened: the pool is the
         * caller's.
         *
         * @returns {Promise<any>}
         */
        close() {
            closed = true;
            // wake everyone in the queue so they see `closed` and refuse, instead of waiting on
            // a release that will never come
            for (const waiter of waiters.splice(0)) {
                waiter();
            }
            return Promise.all(slots.filter(Boolean).map((slot) => slot.client.end().catch(() => {})));
        }
    };
}

module.exports = { createDispatcher, isConnectionError };
