"use strict";

// The types are written by hand, the runtime is JavaScript, and nothing in the language ties one
// to the other: a helper added to src/index.js and forgotten in src/types.d.ts is invisible to
// every other test, and so is a member declared in the d.ts that no longer exists. This walks
// both surfaces and compares them by name, so drift fails here instead of in someone's editor.
//
// Names only. Whether a signature is right is the type fixture's job, tests/types/api.ts, which
// the typecheck script compiles.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createSql, sql } = require("../../src/index.js");

const DTS = path.join(__dirname, "..", "..", "src", "types.d.ts");
const INDEX = path.join(__dirname, "..", "..", "src", "index.js");

/**
 * The d.ts with its comments removed, so a brace inside a comment cannot be read as syntax.
 *
 * @returns {string}
 */
function declarations() {
    return fs
        .readFileSync(DTS, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
}

/**
 * Where an interface starts, or -1. Found by text rather than by a pattern so that a longer name
 * cannot answer for a shorter one: `interface Query` must not find `interface QueryResult`.
 *
 * @param {string} source
 * @param {string} name
 * @returns {number}
 */
function interfaceAt(source, name) {
    const marker = "interface " + name;
    for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
        const after = source.charAt(i + marker.length);
        if (!/[A-Za-z0-9_]/.test(after)) {
            return i;
        }
    }
    return -1;
}

/**
 * The members an interface declares, by name. Read here rather than through the TypeScript
 * compiler API: tsc 7 is a Go program whose npm package no longer carries that API, and this test
 * has to keep working whichever compiler is installed. It reads one file, ours, written in a
 * style we control, and it says so loudly when it parses nothing.
 *
 * @param {string} name
 * @returns {string[]}
 */
function declaredMembers(name) {
    const source = declarations();
    const start = interfaceAt(source, name);
    assert.ok(start !== -1, "no interface named " + name + " in types.d.ts");
    const open = source.indexOf("{", start);
    assert.ok(open !== -1, "interface " + name + " has no body");

    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i++) {
        if (source[i] === "{") {
            depth++;
        } else if (source[i] === "}") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    const body = source.slice(open + 1, end);

    // split on the semicolons that end a member, which are the ones outside any nested braces,
    // brackets or parentheses. Angle brackets are left out of the count on purpose: the > of an
    // arrow has no < to match it, and a member's semicolon never sits inside a generic anyway.
    /** @type {string[]} */
    const chunks = [];
    let level = 0;
    let current = "";
    for (const ch of body) {
        if ("{[(".includes(ch)) {
            level++;
        } else if ("}])".includes(ch)) {
            level--;
        }
        if (ch === ";" && level === 0) {
            chunks.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    chunks.push(current);

    /** @type {string[]} */
    const found = [];
    for (const chunk of chunks) {
        // a named member: `foo(...)`, `foo?: X`, `readonly foo: X`. A call signature starts with
        // ( or <, an index signature with [, and neither is this test's business.
        const match = chunk.trim().match(/^(?:readonly\s+)?([A-Za-z_]\w*)\s*[?(<:]/);
        if (match) {
            found.push(match[1]);
        }
    }
    assert.ok(found.length > 0, "parsed no members out of interface " + name);
    return found;
}

/**
 * What a runtime object really carries, minus the noise every function has.
 *
 * @param {any} value
 * @returns {string[]}
 */
function runtimeMembers(value) {
    // length, name and prototype are what every function carries; on anything else they are
    // real members, and Query does declare a `name`
    const skip = typeof value === "function" ? ["length", "name", "prototype", "constructor"] : ["constructor"];
    return Object.getOwnPropertyNames(value).filter((key) => !skip.includes(key) && !key.startsWith("_"));
}

test("every helper on the tag is declared, and every declared helper exists", () => {
    const pool = { options: {}, query: async (cfg) => cfg };
    const tag = createSql(pool, { pipeline: false });

    const declared = new Set([...declaredMembers("SqlHelpers"), ...declaredMembers("RunnerSql")]);
    const actual = new Set(runtimeMembers(tag));

    const undeclared = [...actual].filter((key) => !declared.has(key));
    const missing = [...declared].filter((key) => !actual.has(key));
    assert.deepStrictEqual(undeclared, [], "on the tag but not in types.d.ts");
    assert.deepStrictEqual(missing, [], "in types.d.ts but not on the tag");
});

test("the pure builder carries the helpers and nothing the runner adds", () => {
    const declared = new Set(declaredMembers("SqlHelpers"));
    const actual = new Set(runtimeMembers(sql));

    const undeclared = [...actual].filter((key) => !declared.has(key));
    assert.deepStrictEqual(undeclared, [], "on the builder but not in SqlHelpers");
    // close() and pipelining belong to the runner, and the builder must not grow them
    for (const runnerOnly of declaredMembers("RunnerSql")) {
        assert.ok(!actual.has(runnerOnly), "the builder should not carry " + runnerOnly);
    }
});

test("a built query carries what the Query and BuiltQuery types promise", () => {
    const query = sql`select ${1}`;
    const proto = Object.getPrototypeOf(query);
    const actual = new Set([...runtimeMembers(query), ...runtimeMembers(proto)]);

    for (const name of declaredMembers("Query")) {
        assert.ok(actual.has(name), "Query declares " + name + " and the runtime does not have it");
    }
    for (const name of declaredMembers("BuiltQuery")) {
        assert.ok(actual.has(name), "BuiltQuery declares " + name + " and the runtime does not have it");
    }
    // freshName is an internal of the retry path: it must not have leaked into the contract
    const declaredEverywhere = new Set([...declaredMembers("Query"), ...declaredMembers("BuiltQuery")]);
    assert.ok(!declaredEverywhere.has("freshName"), "freshName is internal and should not be declared");
});

test("every option createSql reads is declared, and every declared option is read", () => {
    const source = fs.readFileSync(INDEX, "utf8");
    // the one destructuring of the options argument in createSql
    const match = source.match(/const \{([^}]+)\} = options;/);
    assert.ok(match, "could not find the options destructuring in src/index.js");
    const read = match[1]
        .split(",")
        .map((part) => part.trim().split(/[=:]/)[0].trim())
        .filter(Boolean);

    const declared = declaredMembers("CreateSqlOptions");
    assert.deepStrictEqual(
        read.filter((key) => !declared.includes(key)),
        [],
        "read by createSql but not in CreateSqlOptions"
    );
    assert.deepStrictEqual(
        declared.filter((key) => !read.includes(key)),
        [],
        "in CreateSqlOptions but never read by createSql"
    );
});

test("the sibling overrides the types offer are the ones options() accepts", () => {
    const source = fs.readFileSync(INDEX, "utf8");
    for (const key of declaredMembers("OptionOverrides")) {
        assert.ok(
            source.includes('"' + key + '" in overrides'),
            "OptionOverrides declares " + key + ", derive() ignores it"
        );
    }
});
