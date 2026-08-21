// Hand-written types for what the module exports. The runtime is plain JavaScript and stays
// that way; this file is the contract, so it names what a caller may touch and stays silent
// about the insides. Pool and QueryResult come from @types/pg, the same package
// a pg user already has for their own code.

declare module "pg-telaio" {
    import type { Pool, QueryResult, QueryResultRow } from "pg";

    /** The object pg accepts. A built Query has this shape, so pool.query(sql`...`) works as it is. */
    export interface PgQueryConfig {
        /** The statement name, present when the tag prepares or named() chose one. */
        name?: string;
        /** The SQL text with $n placeholders. */
        text: string;
        /** The parameters, in placeholder order. */
        values: unknown[];
    }

    // The helpers return marker objects the compiler recognises when the query text is built.
    // Their insides are not API, so each is opaque here: something to place into a template,
    // nothing to read. The brand fields do not exist at runtime, they only keep one marker from
    // passing where another is required.

    /** One or more identifiers to quote into the text, never parameters. From sql.ident(). */
    export interface Identifier {
        readonly _telaio: "identifier";
    }

    /** A parenthesised parameter list, the explicit form of `in ${sql.list([1, 2, 3])}`. */
    export interface ParamList {
        readonly _telaio: "list";
    }

    /** The `("a", "b") values ($1, $2), ($3, $4)` shape of an insert. From sql.values(). */
    export interface InsertValues {
        readonly _telaio: "values";
    }

    /** The `"a" = $1, "b" = $2` list of an update. From sql.set(). */
    export interface SetValues {
        readonly _telaio: "set";
    }

    /** A single parameter whose wire form was chosen explicitly. From sql.json() and sql.array(). */
    export interface WrappedParam {
        readonly _telaio: "param";
    }

    /**
     * What `sql(value, ...keys)` returns when called as a function instead of a tag: the SQL
     * around it decides its meaning when the query compiles, and a position the compiler cannot
     * read raises an error naming the explicit helper to use instead.
     */
    export interface Dynamic {
        readonly _telaio: "dynamic";
    }

    /**
     * A query that was only built: it has the shape pg accepts, so it can be handed to
     * `pool.query()` as it is, and it can be spliced into another template as a fragment. It is
     * not awaitable - `join()` and `build()` return this, and so does everything the pure
     * builder makes.
     */
    export interface BuiltQuery {
        /** The SQL text with $n placeholders, compiled on first read. */
        readonly text: string;
        /** The parameters, in placeholder order. */
        readonly values: unknown[];
        /** The statement name when the tag prepares or named() chose one, undefined otherwise. */
        readonly name?: string;
        /** Gives this one query a caller-chosen statement name. Chainable. */
        named(name: string): this;
    }

    /**
     * A built query. It has the shape pg accepts, so it can be handed to `pool.query()` as it
     * is; made by a runner tag it is also a lazy promise, and nothing runs until the first
     * `then`, which is what lets an unawaited call be spliced into another template as a
     * fragment.
     */
    export interface Query<R extends QueryResultRow = any> extends PromiseLike<QueryResult<R>> {
        /** The SQL text with $n placeholders, compiled on first read. */
        readonly text: string;
        /** The parameters, in placeholder order. */
        readonly values: unknown[];
        /** The statement name when the tag prepares or named() chose one, undefined otherwise. */
        readonly name?: string;
        /** Gives this one query a caller-chosen statement name. Chainable. */
        named(name: string): this;
        /** Runs the query once and caches the promise, so awaiting twice does not run it twice. */
        then<T1 = QueryResult<R>, T2 = never>(
            onfulfilled?: ((value: QueryResult<R>) => T1 | PromiseLike<T1>) | null,
            onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
        ): Promise<T1 | T2>;
        catch<T = never>(onrejected?: ((reason: any) => T | PromiseLike<T>) | null): Promise<QueryResult<R> | T>;
        finally(onfinally?: (() => void) | null): Promise<QueryResult<R>>;
    }

    /** What sql.options() takes: leave a field out to keep the tag's current answer. */
    export interface OptionOverrides {
        /** Name the statements or not. */
        prepare?: boolean;
        /** `false` routes through pool.query(); anything else keeps the tag's routing. */
        pipeline?: boolean;
    }

    /**
     * The tag and its helpers, shared by the runner and the pure builder so a fragment built
     * anywhere composes anywhere.
     */
    export interface SqlHelpers {
        /** The tag itself: every value becomes a $n parameter unless it is a fragment or a helper's marker. */
        <R extends QueryResultRow = any>(strings: TemplateStringsArray, ...values: unknown[]): Query<R>;
        /** `sql("name")`: an identifier. */
        (value: string): Dynamic;
        /** `sql(rows, ...keys)` after `insert into t`: a multi-row insert. */
        (rows: object[], ...keys: string[]): Dynamic;
        /** `sql([...])`: a parameter list after `in`, identifiers after `select` and friends. */
        (values: unknown[]): Dynamic;
        /** `sql(row, ...keys)`: an insert or a set list, depending on where it lands. */
        (row: object, ...keys: string[]): Dynamic;

        /** The explicit identifier helper: one name or a list, dotted names quoted per part. */
        ident(names: string | string[]): Identifier;
        /** The explicit list helper; an empty list compiles to `(null)`, which matches nothing. */
        list(items: unknown[]): ParamList;
        /** The explicit insert helper; keys default to the first row's own keys. */
        values(rows: object | object[], keys?: string[]): InsertValues;
        /** The explicit update helper; keys default to the object's own keys. */
        set(row: object, keys?: string[]): SetValues;
        /** Joins fragments or values with a separator, ", " by default. Returns a fragment, not a promise. */
        join(parts: unknown[], separator?: string): BuiltQuery;
        /** Splices SQL text as-is, the caller vouching for it; `values` are its $1..$n. Never prepared. */
        unsafe<R extends QueryResultRow = any>(text: string, values?: unknown[]): Query<R>;
        /** Sends the value as its JSON text, for the cases pg's own serialisation would send something else. */
        json(value: unknown): WrappedParam;
        /** Sends a JS array as a Postgres array parameter, said out loud. */
        array(value: unknown[]): WrappedParam;
        /** Builds without running, whichever tag it hangs on. Not a promise: hand it to pool.query(). */
        build(strings: TemplateStringsArray, ...values: unknown[]): BuiltQuery;
        /** A sibling tag with some options changed, sharing the connections and the statement names. */
        options(overrides: OptionOverrides): this;

        /** This tag without named statements. */
        readonly unprepared: this;
        /** This tag with named statements. */
        readonly prepared: this;
        /** This tag routed through pool.query(), past the pipelined connections. */
        readonly direct: this;
    }

    /** The tag createSql() returns. */
    export interface RunnerSql extends SqlHelpers {
        /** Closes the tag's own connections. The pool is the caller's and stays up. */
        close(): Promise<void>;
        /** `await using sql = createSql(pool)`: close() at scope exit. The syntax needs Node 24. */
        [Symbol.asyncDispose](): Promise<void>;
        /** How many connections the tag opened next to the pool; 0 means everything rides pool.query(). */
        readonly pipelining: number;
    }

    /**
     * The pure builder: the same tag without a pool behind it. Awaiting one of its queries is a
     * runtime error, and the type cannot say so, because the Query it builds is the same shape
     * the runner runs; hand what it builds to `pool.query()` instead.
     */
    export interface BuilderSql extends SqlHelpers {}

    export interface CreateSqlOptions {
        /**
         * Name the statements, on by default. Pass false behind a transaction-mode pgbouncer
         * that does not track prepared statements.
         */
        prepare?: boolean;
        /**
         * "auto" opens connections only while the pool cannot pipeline by itself; a number opens
         * exactly that many; `false` sends everything through pool.query().
         */
        pipeline?: "auto" | false | number;
        /** Queries in flight per connection before callers queue. Default 100. */
        maxPipeline?: number;
        /**
         * How long a pipelined connection may go without a reply before new queries stop being
         * sent to it and ride pool.query() instead. Default 50, `false` turns the guard off.
         */
        stallMillis?: number | false;
        /** Retry once when a schema change or a pgbouncer invalidates a prepared statement. Default true. */
        retry?: boolean;
        /** Statement-name prefix, "telaio" by default: names are prefix_N. Letters, digits, underscores. */
        prefix?: string;
    }

    /**
     * The runner factory. Takes the pg Pool the application already has and returns the tag;
     * the pool comes back untouched and is never ended here.
     */
    export function createSql(
        pool: Pool | { query(config: PgQueryConfig): Promise<any> },
        options?: CreateSqlOptions
    ): RunnerSql;

    /** The pure builder, importable with nothing else installed. */
    export const sql: BuilderSql;
}
