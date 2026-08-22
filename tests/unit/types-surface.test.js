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
const path = require("node:path");
const ts = require("typescript");

const { createSql, sql } = require("../../src/index.js");

const DTS = path.join(__dirname, "..", "..", "src", "types.d.ts");

/**
 * The members an interface declares in the d.ts, by name. Only the interface's own members: what
 * it inherits is checked through the interface it extends.
 *
 * @param {string} name
 * @returns {string[]}
 */
function declaredMembers(name) {
    const source = ts.createSourceFile(DTS, require("node:fs").readFileSync(DTS, "utf8"), ts.ScriptTarget.ES2022, true);
    /** @type {string[]} */
    const found = [];
    /** @param {any} node */
    const walk = (node) => {
        if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
            for (const member of node.members) {
                // the call signatures of the tag itself have no name, and neither do index
                // signatures; both are the fixture's business, not this test's
                if (member.name && ts.isIdentifier(member.name)) {
                    found.push(member.name.text);
                }
            }
        }
        ts.forEachChild(node, walk);
    };
    walk(source);
    assert.ok(found.length > 0, "no interface named " + name + " in types.d.ts");
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
    const source = require("node:fs").readFileSync(path.join(__dirname, "..", "..", "src", "index.js"), "utf8");
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
    const source = require("node:fs").readFileSync(path.join(__dirname, "..", "..", "src", "index.js"), "utf8");
    for (const key of declaredMembers("OptionOverrides")) {
        assert.ok(
            source.includes('"' + key + '" in overrides'),
            "OptionOverrides declares " + key + ", derive() ignores it"
        );
    }
});
