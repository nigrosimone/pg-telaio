"use strict";

// Shared setup for the integration suites. On a dev machine without the bench container the
// suites skip themselves; in CI the database is provisioned, so there REQUIRE_DB=1 turns an
// unreachable database into a failure instead of a silent green run.

const { Pool } = require("pg");

const URL = process.env.DATABASE_URL || "postgres://bench:bench@localhost:55432/benchmark";
const REQUIRE_DB = process.env.REQUIRE_DB === "1";

/**
 * One pool for a whole suite, or null when the database does not answer within ~2s. With
 * REQUIRE_DB=1 unreachable throws instead, so a broken CI service cannot pass as a skip.
 *
 * @returns {Promise<any>}
 */
async function openPool() {
    const pool = new Pool({ connectionString: URL, connectionTimeoutMillis: 2000 });
    // a backend killed elsewhere surfaces here; without a listener it takes the process down
    pool.on("error", () => {});
    try {
        await pool.query("select 1");
        return pool;
    } catch (err) {
        await pool.end().catch(() => {});
        if (REQUIRE_DB) {
            throw new Error("REQUIRE_DB=1 and no database at " + URL, { cause: err });
        }
        return null;
    }
}

module.exports = { URL, openPool };
