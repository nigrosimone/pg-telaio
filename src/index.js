"use strict";

// A tagged template for node-postgres.
//
//   const sql = createSql(pool, { prepare: true })
//   const { rows } = await sql`select id, name from items where id = ${id}`
//
// Values become parameters, never string concatenation. With `prepare` the statement is also
// named, so Postgres parses it once per connection and every later call skips the parse; when a
// schema change invalidates the server-side plan, the query is retried once under a fresh name.
//
// Underneath, queries are pipelined - sent without waiting for the previous result - for as long
// as pg itself cannot do that: `pipeline: true` exists in pg since 8.23.0 but does nothing
// through `pool.query()`, because the pool checks out a connection per query and a second query
// never sits behind a first. Until then the tag keeps a few connections of its own next to the
// pool, opened on demand like the pool's; the day the pool pipelines, `auto` opens nothing and
// every query goes back through `pool.query()` with no code change.
//
// The pool keeps everything else. Transactions, LISTEN/NOTIFY and COPY go through
// `pool.connect()` as always: a pipelined connection carries queries from several callers at
// once, so a BEGIN on it would fence other people's work.

const { Query, Identifier, Raw, ParamList, InsertValues, SetValues, Dynamic, WrappedParam } = require("./query");
const { createDispatcher } = require("./dispatcher");

// The two ways a prepared statement dies without the query being wrong. 0A000 is "cached plan
// must not change result type", what a schema change does to a named statement; 26000 is
// "prepared statement does not exist", what a transaction-mode pgbouncer does to it. Both fail
// before the query runs, so retrying once under a fresh name is safe for writes too.
const RETRY_CODES = new Set(["0A000", "26000"]);

/**
 * True when the first argument is a template strings array, which is how a tag call is told
 * apart from `sql(value, ...keys)` used as a helper.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isTemplate(value) {
    return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "raw");
}

/**
 * A pool that pipelines by itself normalises `maxPipeline` into its options and keeps a boolean
 * for it. Reading that is a probe, not a contract: when it is wrong the only cost is that the tag
 * opens its own connections, which is what it does anyway today.
 *
 * @param {any} pool
 * @returns {boolean}
 */
function poolPipelines(pool) {
    return !!pool.options && pool.options.maxPipeline > 1 && typeof pool._pipeline === "boolean";
}

/**
 * The pool's connection config with its secrets restored: pg-pool hides `password` and
 * `ssl.key` behind non-enumerable properties so they stay out of stack traces, which also means
 * a spread drops them and the dispatcher's connections would fail to authenticate.
 *
 * @param {any} pool
 * @returns {object}
 */
function configOf(pool) {
    const options = pool.options || {};
    const config = { ...options };
    if (options.password !== undefined) {
        config.password = options.password;
    }
    if (options.ssl && options.ssl.key !== undefined) {
        config.ssl = { ...options.ssl, key: options.ssl.key };
    }
    delete config.max;
    delete config.min;
    delete config.Client;
    return config;
}

/**
 * Attaches the query-building helpers to a tag. They are the same on every tag this module
 * hands out, the pure builder included, so a fragment built anywhere composes anywhere.
 *
 * @param {any} tag the function to decorate
 * @param {{ prepare: boolean, direct: boolean, prefix?: string }} opts what this tag stamps on its queries
 * @param {((query: Query) => Promise<any>)|null} exec how this tag runs queries, null to only build
 * @param {(overrides: object) => any} derive builds a sibling tag with options changed
 * @returns {any} the decorated tag
 */
function decorate(tag, opts, exec, derive) {
    /**
     * The explicit identifier helper: `sql.ident("users")` or `sql.ident(["a", "b"])`.
     *
     * @param {string|string[]} names
     * @returns {Identifier}
     */
    tag.ident = (names) => new Identifier(names);

    /**
     * The explicit list helper: `where id in ${sql.list([1, 2, 3])}`.
     *
     * @param {unknown[]} items
     * @returns {ParamList}
     */
    tag.list = (items) => new ParamList(items);

    /**
     * The explicit insert helper: `insert into t ${sql.values(rows, ["a", "b"])}`.
     *
     * @param {object|object[]} rows
     * @param {string[]} [keys]
     * @returns {InsertValues}
     */
    tag.values = (rows, keys) => new InsertValues(rows, keys);

    /**
     * The explicit update helper: `set ${sql.set(row, ["a", "b"])}`.
     *
     * @param {object} row
     * @param {string[]} [keys]
     * @returns {SetValues}
     */
    tag.set = (row, keys) => new SetValues(row, keys);

    /**
     * Joins fragments or values with a separator, `", "` by default:
     * `order by ${sql.join([sql.ident("a"), sql.ident("b")])}`.
     *
     * @param {unknown[]} parts
     * @param {string} [separator]
     * @returns {Query} a fragment
     */
    tag.join = (parts, separator = ", ") => {
        const strings = ["", ...Array(Math.max(parts.length - 1, 0)).fill(separator), ""];
        if (parts.length === 0) {
            return new Query([""], [], { prepare: false, direct: opts.direct }, null);
        }
        return new Query(strings, parts, { prepare: false, direct: opts.direct }, null);
    };

    /**
     * Splices SQL text as-is, the caller vouching for it. Runnable on a runner tag and usable as
     * a fragment; never prepared.
     *
     * @param {string} text
     * @param {unknown[]} [values] parameters the text refers to as $1..$n
     * @returns {Query}
     */
    tag.unsafe = (text, values = []) => new Query(["", ""], [new Raw(text, values)], { prepare: false, direct: opts.direct }, exec);

    /**
     * Sends a value as its JSON text, for the cases pg's own serialisation would send something
     * else - a JS array becomes a Postgres array, not JSON, unless it goes through here.
     *
     * @param {unknown} value
     * @returns {WrappedParam}
     */
    tag.json = (value) => new WrappedParam(JSON.stringify(value));

    /**
     * Sends a JS array as a Postgres array parameter. pg does this by default; the helper says
     * it out loud.
     *
     * @param {unknown[]} value
     * @returns {WrappedParam}
     */
    tag.array = (value) => new WrappedParam(value);

    /**
     * Builds without running: the returned object carries `text`, `values` and, when this tag
     * prepares, `name`, which is exactly what `pool.query()` accepts.
     *
     * @param {readonly string[]} strings
     * @param {...unknown} values
     * @returns {Query}
     */
    tag.build = (strings, ...values) =>
        new Query(strings, values, { prepare: opts.prepare, direct: opts.direct, prefix: opts.prefix }, null);

    /**
     * A sibling tag with some options changed, sharing the connections and the statement names:
     * `sql.options({ prepare: false })`.
     *
     * @param {{ prepare?: boolean, pipeline?: boolean }} overrides
     * @returns {any}
     */
    tag.options = (overrides) => derive(overrides);

    // the two common overrides, as properties so they read like the query means it:
    // `await sql.unprepared`select ...``, `await sql.direct`select ...``
    Object.defineProperty(tag, "unprepared", {
        get() {
            return derive({ prepare: false });
        }
    });
    Object.defineProperty(tag, "prepared", {
        get() {
            return derive({ prepare: true });
        }
    });
    Object.defineProperty(tag, "direct", {
        get() {
            return derive({ pipeline: false });
        }
    });

    return tag;
}

/**
 * Makes one tag: template call builds a Query, plain call is the polymorphic helper -
 * `sql("name")` an identifier, `sql(obj, ...keys)` an insert or set depending on where it lands,
 * `sql([...])` a list.
 *
 * @param {{ prepare: boolean, direct: boolean, prefix?: string }} opts
 * @param {((query: Query) => Promise<any>)|null} exec
 * @param {(overrides: object) => any} derive
 * @returns {any}
 */
function makeTag(opts, exec, derive) {
    /**
     * @param {any} first template strings array, or the helper's value
     * @param {...any} rest template values, or the helper's keys
     * @returns {Query|Dynamic}
     */
    const tag = (first, ...rest) => {
        if (isTemplate(first)) {
            return new Query(first, rest, opts, exec);
        }
        return new Dynamic(first, rest);
    };
    return decorate(tag, opts, exec, derive);
}

/**
 * The runner factory. Takes the pg Pool the application already has and returns the tag;
 * the pool comes back untouched and is never ended here.
 *
 * @param {any} pool a pg Pool (or anything with a compatible `query`)
 * @param {object} [options]
 * @param {boolean} [options.prepare] name the statements, on by default. Pass `false` behind a
 *   transaction-mode pgbouncer that does not track prepared statements: there a named statement
 *   dies between calls and every query would pay the retry
 * @param {"auto"|false|number} [options.pipeline] `"auto"` opens connections only while the
 *   pool cannot pipeline by itself; a number opens exactly that many; `false` sends everything
 *   through `pool.query()`
 * @param {number} [options.maxPipeline] queries in flight per connection before callers queue
 * @param {number|false} [options.stallMillis] how long a pipelined connection may go without a
 *   reply before new queries stop being sent to it and ride `pool.query()` instead; `false`
 *   turns the guard off
 * @param {boolean} [options.retry] retry once when a schema change or a pgbouncer invalidates
 *   a prepared statement
 * @param {string} [options.prefix] the statement-name prefix, "telaio" by default; names are
 *   `prefix_N`, so pg_prepared_statements says which application prepared what
 * @returns {any} the tag
 */
function createSql(pool, options = {}) {
    if (!pool || typeof pool.query !== "function") {
        throw new TypeError("createSql(pool): a pg Pool is required");
    }
    const { prepare = true, pipeline = "auto", maxPipeline = 100, stallMillis = 50, retry = true, prefix = "telaio" } = options;
    if (typeof prefix !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
        throw new TypeError("createSql: prefix must be letters, digits or underscores, starting with a letter or underscore");
    }

    const connections = pipeline === "auto" ? (poolPipelines(pool) ? 0 : 3) : pipeline === false ? 0 : pipeline;
    let dispatcher = null;
    if (connections > 0) {
        const Client = pool.Client || require("pg").Client;
        dispatcher = createDispatcher(Client, configOf(pool), {
            connections,
            maxPipeline,
            stallMillis: stallMillis === false ? 0 : stallMillis,
            // where a query goes while every pipelined connection is stuck behind a slow one
            // the pool takes the queries while every pipelined connection is blocked, so it
            // needs room: a one-connection pool would serialise the whole worker there
            overflow: (cfg) => pool.query(cfg)
        });
    }

    /**
     * Runs one built query, routing past the pool while the dispatcher exists and the query did
     * not ask for `direct`, and retrying once when the server refused the prepared statement
     * rather than the query.
     *
     * @param {Query} query
     * @returns {Promise<any>}
     */
    const run = async (query) => {
        const text = query.text;
        const values = query.values;
        const name = query.name;
        const route = dispatcher && !query.direct ? dispatcher : pool;
        try {
            return await route.query(name === undefined ? { text, values } : { name, text, values });
        } catch (err) {
            if (retry && name !== undefined && RETRY_CODES.has(/** @type {any} */ (err).code)) {
                const fresh = query.freshName(name);
                return route.query({ name: fresh, text, values });
            }
            throw err;
        }
    };

    /**
     * Builds the tag for one option set; `derive` hands out siblings that share `run`, the
     * dispatcher and the statement names.
     *
     * @param {{ prepare: boolean, direct: boolean, prefix?: string }} opts
     * @returns {any}
     */
    const make = (opts) => {
        const tag = makeTag(opts, run, (overrides) =>
            make({
                prepare: "prepare" in overrides ? !!overrides.prepare : opts.prepare,
                direct: "pipeline" in overrides ? overrides.pipeline === false : opts.direct,
                prefix: opts.prefix
            })
        );

        /**
         * Closes the tag's own connections. The pool is the caller's and stays up.
         *
         * @returns {Promise<any>}
         */
        tag.close = () => (dispatcher ? dispatcher.close() : Promise.resolve());
        // `await using sql = createSql(pool)` closes the tag's connections at scope exit. The
        // symbol exists on every Node this package supports; the `using` syntax itself needs
        // Node 24. Note the siblings share the dispatcher, so disposing any of them closes it
        // for all, the same way close() does.
        tag[Symbol.asyncDispose] = tag.close;
        // how many connections the tag may open next to the pool, on demand: 0 means
        // everything already rides pool.query()
        tag.pipelining = connections;
        return tag;
    };

    return make({ prepare, direct: false, prefix });
}

/**
 * Builds the pure tag for one option set, recursively so `.options()` keeps working on siblings.
 *
 * @param {{ prepare: boolean, direct: boolean, prefix?: string }} opts
 * @returns {any}
 */
function makeBuilder(opts) {
    return makeTag(opts, null, (overrides) =>
        makeBuilder({
            prepare: "prepare" in overrides ? !!(/** @type {any} */ (overrides).prepare) : opts.prepare,
            direct: false,
            prefix: opts.prefix
        })
    );
}

// The pure builder: the same tag without a pool behind it. It only builds - awaiting one of its
// queries throws - and what it builds is the object pg accepts, so `pool.query(sql`...`)` works
// with nothing else installed.
const sql = makeBuilder({ prepare: false, direct: false });

module.exports = { createSql, sql };
