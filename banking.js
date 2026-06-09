const { randomUUID } = require("node:crypto");
const { query, withTransaction } = require("./db");
const {
    createSessionToken,
    hashPin,
    hashPrivateValue,
    hashToken,
    verifyPin
} = require("./security");

const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_BLOCK_MINUTES = 15;
const LOGIN_MAX_FAILURES = 5;
const TRANSACTION_HISTORY_LIMIT = 50;
const MAX_TRANSACTION_AMOUNT = 1_000_000;

function envInteger(name, fallback, minimum, maximum) {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return value;
}

function moneyFromCents(cents) {
    const value = BigInt(cents);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Stored money value exceeds the safe application limit.");
    }
    return Number(value) / 100;
}

function centsFromAmount(amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_TRANSACTION_AMOUNT) {
        throw new Error("Invalid transaction amount.");
    }
    return BigInt(amount) * 100n;
}

async function getPublicClient(clientId, executor = { query }) {
    const clientResult = await executor.query(
        `SELECT id, account_number, name, phone, balance_cents
         FROM clients
         WHERE id = $1`,
        [clientId]
    );
    const client = clientResult.rows[0];
    if (!client) return null;

    const transactionsResult = await executor.query(
        `SELECT type, amount_cents, created_at
         FROM transactions
         WHERE client_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [clientId, TRANSACTION_HISTORY_LIMIT]
    );

    return {
        accountNumber: client.account_number,
        name: client.name,
        phone: client.phone,
        balance: moneyFromCents(client.balance_cents),
        transactions: transactionsResult.rows.map((transaction) => ({
            type: transaction.type,
            amount: moneyFromCents(transaction.amount_cents),
            date: transaction.created_at
        }))
    };
}

async function authenticate(accountNumber, pinCode) {
    const result = await query(
        `SELECT id, pin_hash
         FROM clients
         WHERE account_number = $1`,
        [accountNumber]
    );
    const client = result.rows[0];

    if (!client) {
        await hashPin(pinCode);
        return null;
    }

    return await verifyPin(pinCode, client.pin_hash) ? client.id : null;
}

async function createSession(clientId) {
    const token = createSessionToken();
    const tokenHash = hashToken(token);
    const ttlHours = envInteger("SESSION_TTL_HOURS", 12, 1, 168);

    await withTransaction(async (client) => {
        await client.query(
            `INSERT INTO sessions (token_hash, client_id, expires_at)
             VALUES ($1, $2, NOW() + ($3::INTEGER * INTERVAL '1 hour'))`,
            [tokenHash, clientId, ttlHours]
        );
        await client.query(
            `DELETE FROM sessions
             WHERE client_id = $1
               AND token_hash NOT IN (
                    SELECT token_hash
                    FROM sessions
                    WHERE client_id = $1 AND expires_at > NOW()
                    ORDER BY created_at DESC, token_hash DESC
                    LIMIT 5
               )`,
            [clientId]
        );
    });

    return { token, ttlSeconds: ttlHours * 60 * 60 };
}

async function getSessionClient(token) {
    if (!token) return null;

    const idleMinutes = envInteger("SESSION_IDLE_MINUTES", 30, 5, 1440);
    const sessionResult = await query(
        `UPDATE sessions
         SET last_seen_at = NOW()
         WHERE token_hash = $1
           AND expires_at > NOW()
           AND last_seen_at > NOW() - ($2::INTEGER * INTERVAL '1 minute')
         RETURNING client_id`,
        [hashToken(token), idleMinutes]
    );

    const session = sessionResult.rows[0];
    if (!session) return null;
    const publicClient = await getPublicClient(session.client_id);
    if (!publicClient) return null;
    return {
        id: session.client_id,
        publicClient
    };
}

async function deleteSession(token) {
    if (!token) return;
    await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

async function deleteExpiredSecurityRecords() {
    await query("DELETE FROM sessions WHERE expires_at <= NOW() OR last_seen_at <= NOW() - INTERVAL '24 hours'");
    await query("DELETE FROM login_throttles WHERE updated_at <= NOW() - INTERVAL '24 hours'");
}

function loginThrottleKeys(accountNumber, ipAddress) {
    return [
        hashPrivateValue("account", accountNumber),
        hashPrivateValue("ip", ipAddress)
    ];
}

async function isLoginBlocked(keys) {
    const result = await query(
        `SELECT EXISTS (
            SELECT 1
            FROM login_throttles
            WHERE key_hash = ANY($1::TEXT[])
              AND blocked_until > NOW()
         ) AS blocked`,
        [keys]
    );
    return result.rows[0].blocked;
}

async function recordLoginFailure(keys) {
    await query(
        `INSERT INTO login_throttles (
            key_hash, failures, window_started_at, blocked_until, updated_at
         )
         SELECT key_hash, 1, NOW(), NULL, NOW()
         FROM UNNEST($1::TEXT[]) AS key_hash
         ON CONFLICT (key_hash) DO UPDATE SET
            failures = CASE
                WHEN login_throttles.window_started_at < NOW() - ($2::INTEGER * INTERVAL '1 minute')
                    THEN 1
                ELSE login_throttles.failures + 1
            END,
            window_started_at = CASE
                WHEN login_throttles.window_started_at < NOW() - ($2::INTEGER * INTERVAL '1 minute')
                    THEN NOW()
                ELSE login_throttles.window_started_at
            END,
            blocked_until = CASE
                WHEN login_throttles.window_started_at < NOW() - ($2::INTEGER * INTERVAL '1 minute')
                    THEN NULL
                WHEN login_throttles.failures + 1 >= $3
                    THEN NOW() + ($4::INTEGER * INTERVAL '1 minute')
                ELSE login_throttles.blocked_until
            END,
            updated_at = NOW()`,
        [keys, LOGIN_WINDOW_MINUTES, LOGIN_MAX_FAILURES, LOGIN_BLOCK_MINUTES]
    );
}

async function clearLoginFailures(keys) {
    await query("DELETE FROM login_throttles WHERE key_hash = ANY($1::TEXT[])", [keys]);
}

async function recordAuditEvent(clientId, eventType, metadata = {}, executor = { query }) {
    await executor.query(
        `INSERT INTO audit_events (id, client_id, event_type, metadata)
         VALUES ($1, $2, $3, $4::JSONB)`,
        [randomUUID(), clientId, eventType, JSON.stringify(metadata)]
    );
}

async function performTransaction(clientId, action, amount, idempotencyKey) {
    const amountCents = centsFromAmount(amount);
    const isWithdrawal = action === "withdraw" || action === "quick";
    const type = isWithdrawal ? "withdraw" : "deposit";

    return withTransaction(async (client) => {
        const accountResult = await client.query(
            `SELECT balance_cents
             FROM clients
             WHERE id = $1
             FOR UPDATE`,
            [clientId]
        );
        if (!accountResult.rows[0]) {
            throw new Error("ACCOUNT_NOT_FOUND");
        }

        const duplicateResult = await client.query(
            `SELECT type, amount_cents
             FROM transactions
             WHERE client_id = $1 AND idempotency_key = $2`,
            [clientId, idempotencyKey]
        );
        const duplicate = duplicateResult.rows[0];
        if (duplicate) {
            if (duplicate.type !== type || BigInt(duplicate.amount_cents) !== amountCents) {
                throw new Error("IDEMPOTENCY_CONFLICT");
            }
            return { client: await getPublicClient(clientId, client), duplicate: true };
        }

        const currentBalance = BigInt(accountResult.rows[0].balance_cents);
        if (isWithdrawal && amountCents > currentBalance) {
            throw new Error("INSUFFICIENT_FUNDS");
        }
        const newBalance = isWithdrawal
            ? currentBalance - amountCents
            : currentBalance + amountCents;
        if (newBalance > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("BALANCE_LIMIT");
        }

        await client.query(
            `UPDATE clients
             SET balance_cents = $1, updated_at = NOW()
             WHERE id = $2`,
            [newBalance.toString(), clientId]
        );
        await client.query(
            `INSERT INTO transactions (
                id, client_id, type, amount_cents, balance_after_cents, idempotency_key
             )
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                randomUUID(),
                clientId,
                type,
                amountCents.toString(),
                newBalance.toString(),
                idempotencyKey
            ]
        );
        await recordAuditEvent(clientId, type, {
            amountCents: amountCents.toString(),
            idempotencyKey
        }, client);

        return { client: await getPublicClient(clientId, client), duplicate: false };
    });
}

module.exports = {
    authenticate,
    clearLoginFailures,
    createSession,
    deleteExpiredSecurityRecords,
    deleteSession,
    getPublicClient,
    getSessionClient,
    isLoginBlocked,
    loginThrottleKeys,
    performTransaction,
    recordAuditEvent,
    recordLoginFailure
};
