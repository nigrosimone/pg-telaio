// The pure builder: what a template compiles to. No database and no pool, the assertions are on
// the exact text and values the tag hands to pg.

const test = require("node:test");
const assert = require("node:assert");

const { sql } = require("../../src/index.js");

test("named() stamps the caller's statement name on a built query", () => {
    const q = sql`select id from items where id = ${1}`.named("items");
    assert.strictEqual(q.name, "items");
    // the name survives the compile and does not disturb text or values
    assert.strictEqual(q.text, "select id from items where id = $1");
    assert.deepStrictEqual(q.values, [1]);
    // works on the unprepared builder, where the automatic name would be undefined
    assert.strictEqual(sql`select 2`.name, undefined);

    for (const bad of ["no good", "1x", "", 7]) {
        assert.throws(() => sql`select 3`.named(/** @type {any} */ (bad)), TypeError);
    }
});

test("a plain template becomes text with $n placeholders and the values in order", () => {
    const q = sql`select id, name from items where id = ${7} and active = ${true}`;
    assert.strictEqual(q.text, "select id, name from items where id = $1 and active = $2");
    assert.deepStrictEqual(q.values, [7, true]);
});

test("reading values before text compiles the same query once", () => {
    const q = sql`select name from items where id = ${8}`;
    assert.deepStrictEqual(q.values, [8]);
    assert.strictEqual(q.text, "select name from items where id = $1");
});

test("the same strings array reuses the cached text", () => {
    // a hand-made template array so it can be mutated, a real one is frozen
    const strings = ["select ", " from items"];
    strings.raw = strings.slice();
    const first = sql(strings, 1);
    assert.strictEqual(first.text, "select $1 from items");
    strings[1] = " from other";
    // still the old text: the second call hit the cache instead of recompiling
    const second = sql(strings, 2);
    assert.strictEqual(second.text, "select $1 from items");
    assert.deepStrictEqual(second.values, [2]);
});

test("a nested fragment splices its text and renumbers across the outer query", () => {
    const cond = sql`price > ${10} or quantity < ${3}`;
    const q = sql`select * from items where id = ${1} and (${cond}) and active = ${true}`;
    assert.strictEqual(q.text, "select * from items where id = $1 and (price > $2 or quantity < $3) and active = $4");
    assert.deepStrictEqual(q.values, [1, 10, 3, true]);
});

test("fragments nest more than one level deep", () => {
    const inner = sql`quantity < ${3}`;
    const mid = sql`(price > ${10} and ${inner})`;
    const q = sql`select * from items where ${mid} or id = ${1}`;
    assert.strictEqual(q.text, "select * from items where (price > $1 and quantity < $2) or id = $3");
    assert.deepStrictEqual(q.values, [10, 3, 1]);
});

test("an empty sql`` fragment is the no-op branch of a conditional", () => {
    const filter = null;
    const off = sql`select * from items ${filter ? sql`where id = ${filter}` : sql``}`;
    assert.strictEqual(off.text, "select * from items ");
    assert.deepStrictEqual(off.values, []);

    const on = sql`select * from items ${sql`where id = ${5}`}`;
    assert.strictEqual(on.text, "select * from items where id = $1");
    assert.deepStrictEqual(on.values, [5]);
});

test("build returns text and values and no name", () => {
    const q = sql.build`select name from items where id = ${9}`;
    assert.strictEqual(q.text, "select name from items where id = $1");
    assert.deepStrictEqual(q.values, [9]);
    assert.strictEqual(q.name, undefined);
});

test("a preparing builder names its statements, stable per text", () => {
    const prepared = sql.options({ prepare: true });
    const a = prepared.build`select id from items where id = ${1}`;
    const b = prepared.build`select id from items where id = ${2}`;
    const c = prepared.build`select name from items where id = ${3}`;
    assert.match(a.name, /^telaio_\d+$/);
    // same text, same name; different text, different name
    assert.strictEqual(a.name, b.name);
    assert.notStrictEqual(a.name, c.name);
});

test("awaiting the pure builder throws a TypeError", async () => {
    await assert.rejects(async () => {
        await sql`select 1`;
    }, TypeError);
});

test("catch and finally on the pure builder throw the same TypeError", () => {
    assert.throws(() => sql`select 1`.catch(() => {}), TypeError);
    assert.throws(() => sql`select 1`.finally(() => {}), TypeError);
});

test("the built object is what pool.query accepts", async () => {
    const pool = { query: async (cfg) => ({ text: cfg.text, values: cfg.values, name: cfg.name }) };
    const got = await pool.query(sql`select * from items where id = ${42}`);
    assert.deepStrictEqual(got, { text: "select * from items where id = $1", values: [42], name: undefined });
});
