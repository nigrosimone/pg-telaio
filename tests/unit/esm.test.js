"use strict";

// The package is CommonJS, and ESM callers get named imports because Node's lexer can read the
// static `module.exports = { ... }`. A refactor to a dynamic export shape would silently take
// `import { createSql }` away from every ESM user, which is what this pins.

const test = require("node:test");
const assert = require("node:assert");

test("the ESM namespace carries createSql and sql as named exports", async () => {
    const ns = await import("../../src/index.js");
    assert.strictEqual(typeof ns.createSql, "function");
    assert.strictEqual(typeof ns.sql, "function");
    // and the default is the whole module, the usual CJS interop
    assert.strictEqual(ns.default.createSql, ns.createSql);
});
