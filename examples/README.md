# Examples

Each file is self-contained: it creates its own scratch table, prints what it does, and cleans
up after itself. They read `DATABASE_URL`, with `postgres://bench:bench@localhost:55432/benchmark`
as the default.

No Postgres at hand? Start one with docker:

```bash
docker run -d --name telaio-examples -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench \
  -e POSTGRES_DB=benchmark -p 55432:5432 postgres:18
```

Then `node examples/01-quickstart.js` and so on.

- [`01-quickstart.js`](./01-quickstart.js): pool plus `createSql`, a few queries, and the close order (`sql.close()` first, then `pool.end()`).
- [`02-per-query-optout.js`](./02-per-query-optout.js): prepare and pipelining on for the tag, off for one query with the `unprepared` and `direct` siblings or `sql.options()`.
- [`03-builder-only.js`](./03-builder-only.js): the pure builder, no pool inside the library; the built object goes straight to `pool.query()`.
- [`04-dynamic-queries.js`](./04-dynamic-queries.js): a list endpoint filter builder with optional fragments, `sql(columns)`, `sql.join` and `sql.ident`.
- [`05-insert-update.js`](./05-insert-update.js): dynamic insert, bulk insert with returning, dynamic set update, `sql.json` for jsonb.
- [`06-transactions.js`](./06-transactions.js): BEGIN/COMMIT through `pool.connect()` while reads keep riding the tag, and why that boundary exists.
- [`07-http-handler.js`](./07-http-handler.js): a plain `node:http` route with the tag as a module-level singleton on the hot read path.
- [`08-using.js`](./08-using.js): `await using` closes the tag at scope exit (Node 24; it is close() spelled by the language).
