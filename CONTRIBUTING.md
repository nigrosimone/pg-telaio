# Working on pg-telaio

The README is for people using this. This file is for people changing it.

## Commands

```sh
npm test                  # unit tests, no database needed
npm run test:integration  # against a real Postgres, needs the docker container below
npm run cover             # both suites under nyc, then a report

npm run lint              # eslint
npm run lint:fix          # eslint, with the fixes applied
npm run format            # prettier, writes
npm run format:check      # prettier, only checks
npm run typecheck         # tsc over the JSDoc types in src

npm run bench             # pool.query() vs the tag, needs the container too
npm run bench:loss        # connections killed under load
```

The integration tests and the bench need a Postgres. One docker command gives it:

```sh
docker run -d --name telaio -e POSTGRES_PASSWORD=bench -e POSTGRES_USER=bench \
  -e POSTGRES_DB=benchmark -p 5432:5432 postgres:18 -c max_connections=256
docker exec -i telaio psql -U bench -d benchmark < bench/seed.sql
```

## Where things live

Three files, and the comment block at the top of each says why it is shaped the way it is:

- `src/index.js` is the tag itself: `createSql`, the helpers, the sibling tags, the retry on a
  dead prepared statement.
- `src/query.js` builds the query: template strings and values in, `{ text, values, name }` out.
  Nothing is compiled until someone reads it, which is what makes a fragment free.
- `src/dispatcher.js` holds the pipelined connections and the stall guard. It is not a pool and
  nothing is checked out: a query goes to the connection with the fewest replies outstanding.

Unit tests run the builder and the dispatcher against a fake; the integration suite runs the
whole thing against the docker Postgres above.

## What a change must hold

These are the contract of the package. A change that breaks one of them is wrong, whatever else
it improves:

- A value interpolated into the tag never reaches the SQL text. It becomes a `$n` parameter, or
  the caller explicitly declared it to be something else: an identifier, a fragment, `sql.unsafe`,
  one of the helpers. There is no third way, and no input may open one.
- The caller's pool is never touched and never ended. The tag opens its own connections next to
  the pool, and `close()` closes only those.
- Replies on a pipelined connection come back in the order the queries were sent, so a slow query
  can hold up every reply queued behind it. Anything on that path needs a test proving a slow
  query cannot silently hold up the fast ones: the stall guard has to be shown routing them
  around it.
- Every fix comes with a regression test that fails without the fix. Revert the fix and run the
  test before claiming it covers anything: red on the unfixed code is the only proof.

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:` and so on. Subject line only,
no body. The changelog and the version bump are generated from them, so a `fix:` that is really
a `feat:` releases the wrong version.
