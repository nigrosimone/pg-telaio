"use strict";

// How a query is put together. The tag collects the template strings and the interpolated
// values; nothing is compiled until someone reads `text`, `values` or awaits the query, so an
// unawaited tag call is a fragment that costs nothing and can be spliced into another query,
// which is how conditional SQL is written and the reason the tag never concatenates a value into
// the text: a value either becomes a $n parameter or it was explicitly declared to be something
// else (an identifier, a raw piece, a helper).

/** Marks a value as one or more identifiers to quote, never parameters. */
class Identifier {
    /**
     * @param {string|string[]} names one identifier, or a list of them
     */
    constructor(names) {
        this.names = Array.isArray(names) ? names : [names];
    }
}

/** A piece of SQL text spliced in as-is, with its own $1..$n values renumbered into place. */
class Raw {
    /**
     * @param {string} text SQL text, trusted by the caller
     * @param {unknown[]} [values] parameters the text refers to as $1..$n
     */
    constructor(text, values = []) {
        this.text = text;
        this.values = values;
    }
}

/** A parenthesised parameter list, the explicit form of `where id in ${sql([1, 2, 3])}`. */
class ParamList {
    /**
     * @param {unknown[]} items
     */
    constructor(items) {
        this.items = items;
    }
}

/** The column/values shape of an insert: `("a", "b") values ($1, $2), ($3, $4)`. */
class InsertValues {
    /**
     * @param {object|object[]} rows one row or a list of rows
     * @param {string[]} [keys] the columns to take, defaults to the first row's own keys
     */
    constructor(rows, keys) {
        this.rows = Array.isArray(rows) ? rows : [rows];
        if (this.rows.length === 0) {
            throw new TypeError("sql.values: at least one row is required");
        }
        this.keys = keys && keys.length ? keys : Object.keys(this.rows[0]);
        if (this.keys.length === 0) {
            throw new TypeError("sql.values: the row has no columns");
        }
    }
}

/** The set list of an update: `"a" = $1, "b" = $2`. */
class SetValues {
    /**
     * @param {object} row
     * @param {string[]} [keys] the columns to take, defaults to the object's own keys
     */
    constructor(row, keys) {
        this.row = row;
        this.keys = keys && keys.length ? keys : Object.keys(row);
        if (this.keys.length === 0) {
            throw new TypeError("sql.set: the object has no columns");
        }
    }
}

/**
 * What `sql(value, ...keys)` returns when called as a function instead of a tag: the meaning
 * depends on where it lands in the query, and that is only known at compile time, so it is
 * resolved by reading the SQL just before it - see resolve().
 */
class Dynamic {
    /**
     * @param {unknown} value object, array of objects, array of values or array of names
     * @param {string[]} keys columns picked explicitly, empty means all own keys
     */
    constructor(value, keys) {
        this.value = value;
        this.keys = keys;
    }
}

/** A single parameter whose wire form was chosen explicitly, see sql.json and sql.array. */
class WrappedParam {
    /**
     * @param {unknown} value already in the form pg should send
     */
    constructor(value) {
        this.value = value;
    }
}

// What decides the meaning of a Dynamic. Order matters: `insert into t` also ends in an
// identifier, so the insert form is tried first. The patterns read only the tail of the text
// built so far, and anything they cannot place raises with the explicit helper to use instead of
// guessing.
const INSERT_TAIL = /\binsert\s+into\s+\S+\s*$/i;
const SET_TAIL = /\bset\s*$/i;
const IN_TAIL = /\b(?:in|not\s+in)\s*$/i;
const IDENT_TAIL = /(?:\b(?:select|returning|distinct|by)|,)\s*$/i;

/**
 * Quotes one possibly dotted identifier. Every part is double-quoted with internal quotes
 * doubled, so a value can never break out of the identifier position.
 *
 * @param {string} name
 * @returns {string}
 */
function quoteIdent(name) {
    if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("sql: an identifier must be a non-empty string");
    }
    return name
        .split(".")
        .map((part) => {
            // checked per part: "a." would otherwise compile to `"a".""`, which Postgres
            // rejects at parse time with a message far from the call that caused it
            if (part.length === 0) {
                throw new TypeError('sql: empty identifier part in "' + name + '"');
            }
            return '"' + part.replace(/"/g, '""') + '"';
        })
        .join(".");
}

/**
 * True for the values the compiler treats as plain parameters. Everything the tag knows how to
 * splice as SQL is an instance of one of the classes above or another Query.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainParam(value) {
    return !(
        value instanceof Query ||
        value instanceof Identifier ||
        value instanceof Raw ||
        value instanceof ParamList ||
        value instanceof InsertValues ||
        value instanceof SetValues ||
        value instanceof Dynamic ||
        value instanceof WrappedParam
    );
}

/**
 * Turns a Dynamic into the concrete shape its position asks for. This is the one place with
 * context sniffing, kept behind explicit escape hatches: when the tail matches nothing, the error
 * names the helper that says what was meant.
 *
 * @param {Dynamic} dynamic
 * @param {string} tail the SQL text compiled so far
 * @returns {Identifier|ParamList|InsertValues|SetValues}
 */
function resolve(dynamic, tail) {
    const { value, keys } = dynamic;
    const isArray = Array.isArray(value);

    if (INSERT_TAIL.test(tail)) {
        if (isArray && value.length === 0) {
            throw new TypeError("sql: cannot insert an empty list of rows");
        }
        return new InsertValues(/** @type {object|object[]} */ (value), keys);
    }
    if (SET_TAIL.test(tail)) {
        if (isArray || value === null || typeof value !== "object") {
            throw new TypeError("sql: `set ${sql(...)}` needs an object");
        }
        return new SetValues(value, keys);
    }
    if (isArray && IN_TAIL.test(tail)) {
        return new ParamList(value);
    }
    if (isArray && IDENT_TAIL.test(tail) && value.every((v) => typeof v === "string")) {
        return new Identifier(value);
    }
    if (typeof value === "string") {
        return new Identifier(value);
    }
    throw new TypeError(
        "sql: cannot tell what this position needs from the surrounding SQL. " +
            "Use sql.ident(), sql.list(), sql.values() or sql.set() to say it explicitly"
    );
}

// Statement names for the prepared path. The name has to be stable for a given text, because pg
// parses a named statement once per connection and skips the parse afterwards, and it has to be
// replaceable, because a schema change invalidates the server-side plan and the only way out
// through pg's public API is to re-prepare under a fresh name. The map is capped: queries whose
// text varies per call (dynamic fragments) would otherwise grow it without bound.
const NAME_CAP = 1000;
const namesByText = new Map();
let nameSeq = 0;

/**
 * The current statement name for a text, minting one on first sight. A hit refreshes the entry's
 * position, so the map evicts least-recently-used and a hot query is never pushed out by a churn
 * of one-off texts: an evicted text that comes back gets a fresh name, and every connection
 * would parse it again while still holding the old statement until it closes. Entries are keyed
 * by prefix and text together, so two tags with different prefixes never share a name.
 *
 * @param {string} text
 * @param {string} [prefix]
 * @returns {string}
 */
function nameFor(text, prefix = "telaio") {
    const key = prefix + "\u0000" + text;
    let name = namesByText.get(key);
    if (name !== undefined) {
        namesByText.delete(key);
        namesByText.set(key, name);
        return name;
    }
    name = prefix + "_" + nameSeq++;
    if (namesByText.size >= NAME_CAP) {
        namesByText.delete(namesByText.keys().next().value);
    }
    namesByText.set(key, name);
    return name;
}

/**
 * Retires a statement name after the server refused it, so the retry re-parses under a fresh
 * one. Only rotates if the failed name is still the current one: with several copies of the same
 * query in flight, every one of them fails and retries, and they should agree on one new name
 * rather than mint one each.
 *
 * @param {string} text
 * @param {string|undefined} prefix
 * @param {string} failedName
 * @returns {string} the name to retry with
 */
function rotateName(text, prefix, failedName) {
    const key = (prefix === undefined ? "telaio" : prefix) + "\u0000" + text;
    if (namesByText.get(key) === failedName) {
        namesByText.delete(key);
    }
    return nameFor(text, prefix);
}

// The fast path for the common case: a template whose every value is a plain parameter always
// compiles to the same text, and the same call site always passes the same frozen strings array,
// so the text is cached on it and the values are used as-is.
const staticTexts = new WeakMap();

/**
 * Compiles strings and values into `text` and `params`, splicing fragments and resolving
 * helpers. Fragment parameters are renumbered into the outer query's sequence.
 *
 * @param {readonly string[]} strings
 * @param {unknown[]} values
 * @returns {{ text: string, params: unknown[] }}
 */
function compile(strings, values) {
    let allPlain = true;
    for (let i = 0; i < values.length; i++) {
        if (!isPlainParam(values[i])) {
            allPlain = false;
            break;
        }
    }
    if (allPlain) {
        let text = staticTexts.get(strings);
        if (text === undefined) {
            text = strings[0];
            for (let i = 1; i < strings.length; i++) {
                text += "$" + i + strings[i];
            }
            staticTexts.set(strings, text);
        }
        return { text, params: values };
    }

    const params = [];
    let text = appendParts(strings, values, "", params);
    return { text, params };
}

/**
 * The recursive worker behind compile(): appends one template's parts to the text built so far,
 * pushing parameters as it goes so $n numbering stays right across nested fragments.
 *
 * @param {readonly string[]} strings
 * @param {unknown[]} values
 * @param {string} text
 * @param {unknown[]} params
 * @returns {string} the extended text
 */
function appendParts(strings, values, text, params) {
    text += strings[0];
    for (let i = 0; i < values.length; i++) {
        let value = values[i];
        if (value instanceof Dynamic) {
            value = resolve(value, text);
        }
        if (value instanceof Query) {
            text = appendParts(value.strings, value.rawValues, text, params);
        } else if (value instanceof Identifier) {
            text += value.names.map(quoteIdent).join(", ");
        } else if (value instanceof Raw) {
            const offset = params.length;
            for (const v of value.values) {
                params.push(v);
            }
            // the raw text numbers its own values from $1, the splice renumbers them into place
            text += value.values.length === 0 ? value.text : value.text.replace(/\$(\d+)/g, (_, n) => "$" + (Number(n) + offset));
        } else if (value instanceof ParamList) {
            if (value.items.length === 0) {
                // `in ()` is not SQL; `in (null)` is, and matches nothing, which is what an
                // empty list means
                text += "(null)";
            } else {
                text += "(" + value.items.map((v) => "$" + params.push(v)).join(", ") + ")";
            }
        } else if (value instanceof InsertValues) {
            text += "(" + value.keys.map(quoteIdent).join(", ") + ") values ";
            text += value.rows
                .map((row) => "(" + value.keys.map((k) => "$" + params.push(/** @type {any} */ (row)[k])).join(", ") + ")")
                .join(", ");
        } else if (value instanceof SetValues) {
            text += value.keys.map((k) => quoteIdent(k) + " = $" + params.push(/** @type {any} */ (value.row)[k])).join(", ");
        } else if (value instanceof WrappedParam) {
            text += "$" + params.push(value.value);
        } else {
            text += "$" + params.push(value);
        }
        text += strings[i + 1];
    }
    return text;
}

/**
 * A built query. It looks like the object pg accepts - `text`, `values` and possibly `name` are
 * enumerable-enough getters - so it can be handed to `pool.query()` directly, and when it was
 * made by a runner tag it is also a lazy promise: nothing runs until the first `then`, which is
 * what lets an unawaited call be used as a fragment inside another query.
 */
class Query {
    /**
     * @param {readonly string[]} strings
     * @param {unknown[]} values
     * @param {{ prepare: boolean, direct?: boolean, prefix?: string }} opts
     * @param {((query: Query) => Promise<any>)|null} exec null for the pure builder
     */
    constructor(strings, values, opts, exec) {
        this.strings = strings;
        this.rawValues = values;
        this.prepare = opts.prepare;
        this.prefix = opts.prefix;
        /** @type {string|null} a caller-chosen statement name, see named() */
        this.statementName = null;
        // a direct query skips the pipelined connections and rides pool.query()
        this.direct = opts.direct === true;
        this._exec = exec;
        /** @type {{ text: string, params: unknown[] }|null} */
        this._compiled = null;
        /** @type {Promise<any>|null} */
        this._promise = null;
    }

    /** The SQL text with $n placeholders, compiled on first read. */
    get text() {
        if (this._compiled === null) {
            this._compiled = compile(this.strings, this.rawValues);
        }
        return this._compiled.text;
    }

    /** The parameters, in placeholder order. */
    get values() {
        if (this._compiled === null) {
            this._compiled = compile(this.strings, this.rawValues);
        }
        return this._compiled.params;
    }

    /**
     * The statement name when the tag prepares, undefined otherwise. Read at execution time,
     * never stored: a schema-change retry rotates it.
     */
    get name() {
        if (this.statementName !== null) {
            return this.statementName;
        }
        return this.prepare ? nameFor(this.text, this.prefix) : undefined;
    }

    /**
     * Gives this one query a caller-chosen statement name, so it is prepared under that name
     * whether or not the tag prepares: `pool.query(sql\`...\`.named("items"))`. The name is the
     * caller's to manage; on a runner tag the schema-change retry falls back to a fresh
     * automatic name, because re-preparing under the same one would collide.
     *
     * @param {string} name
     * @returns {this}
     */
    named(name) {
        if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new TypeError("sql: a statement name must be letters, digits or underscores, starting with a letter or underscore");
        }
        this.statementName = name;
        return this;
    }

    /**
     * The name to retry with after the server refused `failedName`. For an automatic name this
     * rotates the shared entry; for a caller-chosen one it forces a fresh automatic name, since
     * the chosen name is refused and re-preparing under it would collide.
     *
     * @param {string} failedName
     * @returns {string}
     */
    freshName(failedName) {
        if (this.statementName !== null) {
            return rotateName(this.text, this.prefix, nameFor(this.text, this.prefix));
        }
        return rotateName(this.text, this.prefix, failedName);
    }

    /**
     * Runs the query once and caches the promise, so awaiting twice does not run it twice.
     *
     * @param {((value: any) => any)|null} [onFulfilled]
     * @param {((reason: any) => any)|null} [onRejected]
     * @returns {Promise<any>}
     */
    then(onFulfilled, onRejected) {
        if (this._exec === null) {
            throw new TypeError(
                "this sql tag only builds queries; pass the object to pool.query(), or create the tag with createSql(pool) to run it"
            );
        }
        if (this._promise === null) {
            this._promise = this._exec(this);
        }
        return this._promise.then(onFulfilled, onRejected);
    }

    /**
     * @param {(reason: any) => any} onRejected
     * @returns {Promise<any>}
     */
    catch(onRejected) {
        return this.then(null, onRejected);
    }

    /**
     * @param {() => void} onFinally
     * @returns {Promise<any>}
     */
    finally(onFinally) {
        return this.then(null, null).finally(onFinally);
    }
}

// One assignment per export rather than one object: a class exported this way is a type as well
// as a value, which is what the JSDoc annotations in index.js ask of it. Exported as one object
// literal, tsc 7 reads the members as values only and every annotation using them fails.
module.exports.Query = Query;
module.exports.Identifier = Identifier;
module.exports.Raw = Raw;
module.exports.ParamList = ParamList;
module.exports.InsertValues = InsertValues;
module.exports.SetValues = SetValues;
module.exports.Dynamic = Dynamic;
module.exports.WrappedParam = WrappedParam;
module.exports.quoteIdent = quoteIdent;
module.exports.nameFor = nameFor;
module.exports.rotateName = rotateName;
module.exports.compile = compile;
