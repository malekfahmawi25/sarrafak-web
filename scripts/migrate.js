const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { closePool, getPool } = require("../db");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const MIGRATION_LOCK_ID = 684329175;

function checksum(contents) {
    return createHash("sha256").update(contents, "utf8").digest("hex");
}

async function migrate() {
    const client = await getPool().connect();

    try {
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
        await client.query(
            `CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                checksum CHAR(64) NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )`
        );

        const files = fs.readdirSync(MIGRATIONS_DIR)
            .filter((name) => name.endsWith(".sql"))
            .sort();

        for (const name of files) {
            const contents = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
            const fileChecksum = checksum(contents);
            const existing = await client.query(
                "SELECT checksum FROM schema_migrations WHERE name = $1",
                [name]
            );

            if (existing.rows[0]) {
                if (existing.rows[0].checksum !== fileChecksum) {
                    throw new Error(`Migration ${name} changed after it was applied.`);
                }
                continue;
            }

            await client.query("BEGIN");
            try {
                await client.query(contents);
                await client.query(
                    "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
                    [name, fileChecksum]
                );
                await client.query("COMMIT");
                console.log(`Applied migration: ${name}`);
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        }
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
        client.release();
    }
}

migrate()
    .then(() => closePool())
    .catch(async (error) => {
        console.error(error.message);
        await closePool().catch(() => {});
        process.exitCode = 1;
    });

