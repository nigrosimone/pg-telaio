// The helpers. Polymorphic sql() first: the same call means identifier, list, insert or set
// depending on the SQL just before it, and refuses a position it cannot read. Then the explicit
// forms, which say the meaning out loud.

const test = require("node:test");
const assert = require("node:assert");

const { sql } = require("../../src/index.js");

test("sql(string) is an identifier", () => {
    const q = sql`select * from ${sql("items")} where id = ${1}`;
    assert.strictEqual(q.text, 'select * from "items" where id = $1');
    assert.deepStrictEqual(q.values, [1]);
});

test("sql([names]) after select, a comma or by is an identifier list", () => {
    const afterSelect = sql`select ${sql(["id", "name"])} from items`;
    assert.strictEqual(afterSelect.text, 'select "id", "name" from items');

    const afterComma = sql`select id, ${sql(["name", "price"])} from items`;
    assert.strictEqual(afterComma.text, 'select id, "name", "price" from items');

    const afterBy = sql`select * from items order by ${sql(["price", "id"])}`;
    assert.strictEqual(afterBy.text, 'select * from items order by "price", "id"');
});

test("sql([values]) after in or not in is a parameter list", () => {
    const q = sql`select * from items where id in ${sql([1, 2, 3])}`;
    assert.strictEqual(q.text, "select * from items where id in ($1, $2, $3)");
    assert.deepStrictEqual(q.values, [1, 2, 3]);

    const not = sql`select * from items where id not in ${sql([4])}`;
    assert.strictEqual(not.text, "select * from items where id not in ($1)");
    assert.deepStrictEqual(not.values, [4]);
});

test("sql(object) after insert into is columns and values", () => {
    const q = sql`insert into items ${sql({ name: "a", price: 2 })}`;
    assert.strictEqual(q.text, 'insert into items ("name", "price") values ($1, $2)');
    assert.deepStrictEqual(q.values, ["a", 2]);
});

test("sql(object, ...keys) inserts only the named columns", () => {
    const q = sql`insert into items ${sql({ name: "a", price: 2, junk: true }, "name", "price")}`;
    assert.strictEqual(q.text, 'insert into items ("name", "price") values ($1, $2)');
    assert.deepStrictEqual(q.values, ["a", 2]);
});

test("sql([rows]) after insert into is a multi-row insert", () => {
    const rows = [
        { name: "a", price: 1 },
        { name: "b", price: 2 }
    ];
    const q = sql`insert into items ${sql(rows)}`;
    assert.strictEqual(q.text, 'insert into items ("name", "price") values ($1, $2), ($3, $4)');
    assert.deepStrictEqual(q.values, ["a", 1, "b", 2]);
});

test("sql(object) after set is an update list", () => {
    const q = sql`update items set ${sql({ name: "b", price: 3 })} where id = ${1}`;
    assert.strictEqual(q.text, 'update items set "name" = $1, "price" = $2 where id = $3');
    assert.deepStrictEqual(q.values, ["b", 3, 1]);
});

test("a position the tail cannot explain raises instead of guessing", () => {
    const q = sql`values ${sql([1, 2])}`;
    assert.throws(() => q.text, TypeError);
});

test("sql() refuses an empty insert list and a non-object set", () => {
    assert.throws(() => sql`insert into items ${sql([])}`.text, /cannot insert an empty list of rows/);
    assert.throws(() => sql`update items set ${sql([1, 2])}`.text, /needs an object/);
    assert.throws(() => sql`update items set ${sql(null)}`.text, /needs an object/);
});

test("sql.ident quotes dotted names part by part and doubles embedded quotes", () => {
    const dotted = sql`select * from ${sql.ident("public.items")}`;
    assert.strictEqual(dotted.text, 'select * from "public"."items"');

    const quoted = sql`select ${sql.ident('we"ird')} from items`;
    assert.strictEqual(quoted.text, 'select "we""ird" from items');

    const list = sql`select ${sql.ident(["id", "name"])} from items`;
    assert.strictEqual(list.text, 'select "id", "name" from items');
});

test("sql.ident raises at compile time on a bad name", () => {
    assert.throws(() => sql`select ${sql.ident(123)} from items`.text, /must be a non-empty string/);
    assert.throws(() => sql`select ${sql.ident("")} from items`.text, /must be a non-empty string/);
    // checked per part: "a." would otherwise reach Postgres as `"a".""`
    assert.throws(() => sql`select * from ${sql.ident("a.")}`.text, /empty identifier part/);
});

test("sql.list builds the parenthesised list, (null) when empty", () => {
    const q = sql`select * from items where id in ${sql.list([1, 2])}`;
    assert.strictEqual(q.text, "select * from items where id in ($1, $2)");
    assert.deepStrictEqual(q.values, [1, 2]);

    const empty = sql`select * from items where id in ${sql.list([])}`;
    assert.strictEqual(empty.text, "select * from items where id in (null)");
    assert.deepStrictEqual(empty.values, []);
});

test("sql.values builds the insert shape and refuses empty rows or no columns", () => {
    const q = sql`insert into items ${sql.values([{ name: "a" }], ["name"])}`;
    assert.strictEqual(q.text, 'insert into items ("name") values ($1)');
    assert.deepStrictEqual(q.values, ["a"]);

    assert.throws(() => sql.values([]), TypeError);
    assert.throws(() => sql.values({}), TypeError);
});

test("sql.set takes the keys it is given", () => {
    const q = sql`update items set ${sql.set({ name: "x", price: 9 }, ["price"])} where id = ${1}`;
    assert.strictEqual(q.text, 'update items set "price" = $1 where id = $2');
    assert.deepStrictEqual(q.values, [9, 1]);

    assert.throws(() => sql.set({}), TypeError);
});

test("sql.join separates values and fragments, empty join splices nothing", () => {
    const values = sql`select ${sql.join([1, 2, 3])}`;
    assert.strictEqual(values.text, "select $1, $2, $3");
    assert.deepStrictEqual(values.values, [1, 2, 3]);

    const custom = sql`select * from items where ${sql.join([sql`price > ${10}`, sql`quantity < ${5}`], " and ")}`;
    assert.strictEqual(custom.text, "select * from items where price > $1 and quantity < $2");
    assert.deepStrictEqual(custom.values, [10, 5]);

    const empty = sql`select * from items ${sql.join([])}`;
    assert.strictEqual(empty.text, "select * from items ");
    assert.deepStrictEqual(empty.values, []);
});

test("sql.unsafe renumbers its $n into the outer sequence", () => {
    const q = sql`select * from items where id = ${5} and ${sql.unsafe("price > $1 and quantity < $2", [10, 20])}`;
    assert.strictEqual(q.text, "select * from items where id = $1 and price > $2 and quantity < $3");
    assert.deepStrictEqual(q.values, [5, 10, 20]);
});

test("sql.unsafe standing alone keeps its text and values as-is", () => {
    const q = sql.unsafe("select * from items where id = $1", [7]);
    assert.strictEqual(q.text, "select * from items where id = $1");
    assert.deepStrictEqual(q.values, [7]);

    const bare = sql.unsafe("select 1");
    assert.strictEqual(bare.text, "select 1");
    assert.deepStrictEqual(bare.values, []);
});

test("sql.json sends the JSON text, sql.array passes the array through", () => {
    const q = sql`update items set tags = ${sql.json(["a", "b"])} where id = ${1}`;
    assert.strictEqual(q.text, "update items set tags = $1 where id = $2");
    assert.deepStrictEqual(q.values, ['["a","b"]', 1]);

    const arr = sql`select * from items where tags && ${sql.array(["x", "y"])}`;
    assert.strictEqual(arr.text, "select * from items where tags && $1");
    assert.deepStrictEqual(arr.values, [["x", "y"]]);
});
