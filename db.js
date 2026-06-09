const { Pool } = require("pg");

let pool;

function validateConnectionString(connectionString) {
    let databaseUrl;
    try {
        databaseUrl = new URL(connectionString);
    } catch {
        throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
    }

    const isRenderInternalHost = /^dpg-[a-z0-9-]+-a$/.test(databaseUrl.hostname);
    if (isRenderInternalHost && process.env.RENDER !== "true") {
        throw new Error(
            "DATABASE_URL points to a Render internal hostname. Use a local PostgreSQL URL or the Render external URL outside Render."
        );
    }
}

function getPool() {
    if (pool) return pool;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error("DATABASE_URL is required.");
    }
    validateConnectionString(connectionString);

    const sslMode = (process.env.DATABASE_SSL || "disable").toLowerCase();
    const ssl = sslMode === "require" ? { rejectUnauthorized: true } : undefined;

    pool = new Pool({
        connectionString,
        ssl,
        max: Number(process.env.DATABASE_POOL_SIZE) || 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
        application_name: "sarrafak-web"
    });

    pool.on("error", (error) => {
        console.error("Unexpected PostgreSQL pool error:", error.message);
    });

    return pool;
}

function query(text, values) {
    return getPool().query(text, values);
}

async function withTransaction(callback) {
    const client = await getPool().connect();

    try {
        await client.query("BEGIN");
        const result = await callback(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function closePool() {
    if (!pool) return;
    await pool.end();
    pool = undefined;
}

module.exports = {
    closePool,
    getPool,
    query,
    withTransaction
};
