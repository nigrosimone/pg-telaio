// The type fixture. tests/unit/types-surface.test.js compares the names on both sides; this one
// compiles the way a caller writes, so a signature that drifts fails the typecheck script.
//
// Every `@ts-expect-error` here is load-bearing twice over: it says the compiler must refuse the
// line, and tsc reports the directive itself as an error when the line stops being wrong. So a
// type that quietly widens to `any` fails this file too.

import { Pool } from "pg";
import { createSql, sql } from "pg-telaio";

interface Item {
    id: number;
    name: string;
}

const pool = new Pool();
const db = createSql(pool, {
    prepare: true,
    pipeline: "auto",
    maxPipeline: 100,
    stallMillis: 50,
    retry: true,
    prefix: "app"
});

async function rows(): Promise<void> {
    // the row type flows through to the result
    const result = await db<Item>`select id, name from items where id = ${1}`;
    const first: Item = result.rows[0];
    const upper: string = first.name.toUpperCase();
    const count: number = result.rowCount ?? 0;
    console.log(upper, count);

    // without a row type it still runs, and the rows are not narrowed
    const loose = await db`select 1`;
    console.log(loose.rows.length);
}

async function helpers(): Promise<void> {
    const columns = ["id", "name"];
    const row = { name: "chair", price: 12 };

    await db`select ${sql.ident(columns)} from ${sql.ident("items")}`;
    await db`select id from items where id in ${sql.list([1, 2, 3])}`;
    await db`insert into items ${sql.values([row], ["name", "price"])}`;
    await db`update items set ${sql.set(row, ["name"])} where id = ${1}`;
    await db`insert into events (payload) values (${sql.json({ a: 1 })})`;
    await db`select id from items where tags && ${sql.array(["a"])}`;
    await db`select ${sql.unsafe("now()")} as at`;
    await db`select id from items order by ${sql.join([sql.ident("price"), sql.ident("name")])}`;

    // the polymorphic call: identifier, list, insert, set
    await db`select ${sql(columns)} from ${sql("items")} where id in ${sql([1, 2])}`;
    await db`insert into items ${sql(row, "name", "price")}`;
}

async function siblings(): Promise<void> {
    await db.unprepared`select 1`;
    await db.prepared`select 1`;
    await db.direct`select 1`;
    // a sibling is a tag of the same kind, so it chains and keeps close()
    await db.prepared.direct.options({ prepare: false })`select 1`;
    console.log(db.pipelining);
    await db.close();
    await db[Symbol.asyncDispose]();
}

function building(): void {
    // build() and the pure builder hand pg an object, not a promise
    const built = db.build`select ${1}`;
    const text: string = built.text;
    const values: unknown[] = built.values;
    const name: string | undefined = built.name;
    console.log(text, values, name);

    // named() is chainable and keeps the type
    const stamped = sql`select ${1}`.named("items");
    console.log(stamped.name, stamped.text);

    void pool.query(sql`select ${1}`);
    void pool.query(db.build`select ${1}`);
}

// What the compiler must refuse. Each of these is a real mistake a caller can make.
async function refused(): Promise<void> {
    // @ts-expect-error a Pool is required
    createSql();
    // @ts-expect-error stallMillis is a number or false, not a string
    createSql(pool, { stallMillis: "50" });
    // @ts-expect-error there is no such option, and a typo must not pass silently
    createSql(pool, { pipelines: 3 });
    // @ts-expect-error the pure builder has no connections to close
    sql.close();
    // @ts-expect-error and nothing to say about them either
    console.log(sql.pipelining);
    // @ts-expect-error options() takes prepare and pipeline, not the pool-level knobs
    db.options({ maxPipeline: 10 });
    // @ts-expect-error a statement name is a string
    sql`select 1`.named(7);

    const result = await db<Item>`select id, name from items`;
    // @ts-expect-error the row type is honoured: there is no such column
    console.log(result.rows[0].missing);
    // @ts-expect-error rows are objects, not a string
    const wrong: string = result.rows;
    console.log(wrong);
}

void rows();
void helpers();
void siblings();
void refused();
building();
