# pg-telaio

A tagged template for [node-postgres](https://github.com/brianc/node-postgres). Values become
parameters, statements get prepared and named for you when you ask, and underneath the queries are
pipelined for as long as pg's own pool cannot do that.

It takes the pool the application already has, and gives it back untouched.

## Quickstart

```js
const { Pool } = require("pg");
const { createSql } = require("pg-telaio");

const pool = new Pool({ connectionString });
const sql = createSql(pool);

const { rows } = await sql`select id, name from items where id = ${id}`;

await sql.close(); // closes only what the tag opened, the pool stays up
```

The package is CommonJS and works from ESM unchanged: `import { createSql } from "pg-telaio"`.

## The tag

A value is never concatenated into the SQL text. Every interpolated value becomes a `$n`
parameter, unless it was explicitly declared to be something else: an identifier, a fragment, one
of the helpers below.

By default the statement is also named, so Postgres parses it once per connection and every
later call skips the parse. Names are automatic: the first time a text is seen it gets a
name, `telaio_0`, `telaio_1` and so on, and the same text keeps it. The `prefix` option changes the
`telaio` part, so `pg_prepared_statements` says which application prepared what. There is nothing to declare and nothing to invalidate by hand.
The name table holds the 1000 most recently used texts; a workload with more distinct prepared
texts than that keeps re-preparing the cold ones, which is a sign `prepare` is on for queries it
does not fit.

A named statement can die without the query being wrong. A schema change invalidates the
server-side plan (`0A000`, "cached plan must not change result type"), and a transaction-mode
pgbouncer forgets the statement (`26000`, "prepared statement does not exist"). Both fail before
the query runs, so the tag retries once under a fresh name, writes included. `retry: false` turns
that off.

One infrastructure needs an opt-out: a transaction-mode pgbouncer that does not track prepared
statements (`max_prepared_statements` off, or pgbouncer older than 1.21) forgets a named
statement between calls, so there every query would fail and pay the retry. Behind one of those,
pass `prepare: false`.

## Query building

`sql(value, ...keys)` reads the SQL just before it to know what the position needs:

```js
// an identifier: quoted, never a parameter
await sql`select id from ${sql("items")} where id = ${id}`;
// select id from "items" where id = $1

// a column list
await sql`select ${sql(["id", "name"])} from items`;
// select "id", "name" from items

// a list to match against
await sql`select id from items where id in ${sql([1, 2, 3])}`;
// select id from items where id in ($1, $2, $3)

// an insert, columns read from the object
await sql`insert into items ${sql({ name: "chair", price: 12 })}`;
// insert into items ("name", "price") values ($1, $2)

// many rows at once, only the columns you name
await sql`insert into items ${sql(rows, "name", "price")} returning id`;

// an update
await sql`update items set ${sql(patch, "name", "price")} where id = ${id}`;
// update items set "name" = $1, "price" = $2 where id = $3
```

When the position is not one of those, the call throws and names the helper that says what was
meant. The helpers also read better in a long query, and they are the only way to say some of it:

```js
// identifiers, one or a list of them
await sql`select ${sql.ident(["id", "name"])} from ${sql.ident("items")}`;
// select "id", "name" from "items"

// a list of parameters, already in its parentheses
await sql`select id from items where id in ${sql.list([1, 2, 3])}`;
// select id from items where id in ($1, $2, $3)

// an insert, one row or many
await sql`insert into items ${sql.values(rows, ["name", "price"])} returning id`;
// insert into items ("name", "price") values ($1, $2), ($3, $4) returning id

// an update
await sql`update items set ${sql.set(patch, ["name", "price"])} where id = ${id}`;
// update items set "name" = $1, "price" = $2 where id = $3

// a JSON parameter: the same array without json() would go as a Postgres array
await sql`insert into events (payload) values (${sql.json({ tags: ["a", "b"] })})`;
// insert into events (payload) values ($1), with $1 = {"tags":["a","b"]}

// a Postgres array parameter, which is what pg does anyway: the helper says it out loud
await sql`select id from items where tags && ${sql.array(["a", "b"])}`;

// raw text, the caller vouching for it
await sql`select ${sql.unsafe("now() - interval '1 day'")} as since`;
// select now() - interval '1 day' as since
```

Two cautions. Identifiers are always quoted, so a value cannot break out of its position, but a
name is still a name: do not pass untrusted input as an identifier, it would choose which table
or column the query touches. And `sql.unsafe` renumbers every `$n` token in its text when it is
spliced after other parameters, string literals included: keep `$n` out of literals in raw text.

A fragment is an unawaited tag call, and it composes: its parameters are renumbered into the
outer query.

```js
const filter = active === undefined ? sql`` : sql`and active = ${active}`;
const { rows } = await sql`select id from items where price > ${min} ${filter}`;
```

`sql.join(parts, separator)` glues fragments or values with a separator, `", "` by default. An
empty `sql.list([])` compiles to `(null)`, which matches nothing, which is what an empty list
means.

## Per-query opt-outs

The tag hands out siblings that share the connections and the statement names:

```js
const { unprepared, prepared, direct, options } = sql;

await unprepared`...`; // no statement name for this one
await prepared`...`; // a name for this one
await direct`...`; // skip the pipelined connections, ride pool.query()
```

They are not exclusive, every sibling is a tag like the one it came from: `sql.prepared.direct` is
both, and `options()` says the same in one call.

```js
const reports = sql.options({ prepare: true, pipeline: false }); // prepared, past the pipeline
await reports`select ...`;
```

## The pure builder

The module also exports `sql` with no pool behind it. It only builds: what it returns is the
`{ text, values }` object pg accepts, so it works with nothing else wired up. Awaiting one of its
queries throws.

```js
const { sql } = require("pg-telaio");

await pool.query(sql`select * from items where id = ${id}`);
```

`sql.build` on a runner tag does the same, and also stamps `name` when the tag prepares.

A built query can also carry a statement name chosen by the caller, `.named("items")`, and it is
then prepared under that name wherever it runs. On a runner tag the schema-change retry falls
back to a fresh automatic name, because re-preparing under the refused one would collide.

```js
await pool.query(sql`select * from items where id = ${id}`.named("items"));
```

## The pipelining underneath

`pipeline: true` exists in pg since 8.23.0, but passing it to a `Pool` changes nothing:
`pool.query()` checks out a connection per query, so a second query never sits behind the first
and there is nothing to pipeline.

Until pg's own pool does it, the tag keeps a few connections of its own next to the pool, in
pipeline mode, and sends each query to the one with the fewest results outstanding. `maxPipeline`
caps the queries in flight per connection; past the cap, callers queue. The day the pool pipelines
by itself, `pipeline: "auto"` detects it, opens nothing, and every query goes back through
`pool.query()` with no code change. `sql.pipelining` says how many connections the tag opened; 0
means everything already rides the pool.

`sql.close()` closes only those connections. The pool is the caller's and is never ended here.
The tag is also async-disposable, which is the same close() spelled by the language:

```js
await using sql = createSql(pool);
// scope exit closes the tag's connections, success or throw
```

The `await using` syntax needs Node 24; the method behind it is there on every supported Node.

Measured on Postgres 18, primary key read, 3 connections and 64 queries in flight, rounds
alternated between the arms:

|                      | queries/s |              |
| -------------------- | --------- | ------------ |
| `pool.query()`       | 6,539     | 1.00         |
| the tag              | 22,324    | 3.43         |
| `pool.query()` again | 6,458     | 0.96 (noise) |

A query Postgres itself has to work for gains much less: on a sequential scan the same test is
1.46x.

### When a query is slow

This is the cost of sharing a connection: replies come back in the order the queries were sent, so
a slow query delays every reply queued behind it. It is the one way the tag can be slower than the
pool, and from the caller's side it looks like a fast query that took 200ms for no reason.

The tag watches for it. A connection with queries outstanding that has not answered for
`stallMillis` (50 by default) stops receiving new queries until it answers again, and while every
connection is in that state the queries go through `pool.query()`. So a slow query costs the
replies already queued behind it, and nothing more. `stallMillis: false` turns the guard off.

When you know a query is slow, send it past the pipelined connections from the start:

```js
const { rows } = await sql.direct`select ... /* the report nobody waits for */`;
```

## What it does not do

Transactions, LISTEN/NOTIFY and COPY keep going through `pool.connect()`, as always. A pipelined
connection carries queries from several callers at once, so a BEGIN on it would fence other
people's work.

## Options

```js
createSql(pool, {
    prepare: true, // name the statements; false for a pgbouncer that does not track them
    pipeline: "auto", // "auto" | false | number of connections to open
    maxPipeline: 100, // queries in flight per connection before callers queue
    stallMillis: 50, // a connection quiet this long takes no new queries, they ride pool.query()
    retry: true, // retry once when 0A000 or 26000 kills a prepared statement
    prefix: "telaio" // statement names are prefix_N
});
```

There is nothing to say about connecting: the tag's own connections are opened with the pool's
config, the same host, the same credentials, the same `connectionTimeoutMillis`.

## Bench

Needs docker.

```bash
docker run -d --name telaio -e POSTGRES_PASSWORD=bench -e POSTGRES_USER=bench \
  -e POSTGRES_DB=benchmark -p 5432:5432 postgres:18 -c max_connections=256
docker exec -i telaio psql -U bench -d benchmark < bench/seed.sql
node bench/bench.js       # pool vs the tag
node bench/kill.js        # connections killed under load
```
