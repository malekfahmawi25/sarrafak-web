const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { closePool, withTransaction } = require("../db");
const { hashPin } = require("../security");

const inputPath = path.resolve(process.env.IMPORT_FILE || path.join(__dirname, "..", "data", "clients.json"));

function validateClient(client) {
    if (!/^\d{4,32}$/.test(String(client.accountNumber || ""))) {
        throw new Error("Every account number must contain between 4 and 32 digits.");
    }
    if (!client.name || !client.phone || !client.pinCode) {
        throw new Error(`Account ${client.accountNumber} is missing required fields.`);
    }
    if (!Number.isSafeInteger(client.balance) || client.balance < 0) {
        throw new Error(`Account ${client.accountNumber} has an invalid balance.`);
    }
    if (!Array.isArray(client.transactions)) {
        throw new Error(`Account ${client.accountNumber} has invalid transactions.`);
    }
}

async function importClients() {
    const clients = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    if (!Array.isArray(clients)) throw new Error("The import file must contain a JSON array.");

    for (const importedClient of clients) {
        validateClient(importedClient);
        const pinHash = await hashPin(importedClient.pinCode);

        const imported = await withTransaction(async (client) => {
            const insertResult = await client.query(
                `INSERT INTO clients (
                    id, account_number, pin_hash, name, phone, balance_cents
                 )
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (account_number) DO NOTHING
                 RETURNING id`,
                [
                    randomUUID(),
                    String(importedClient.accountNumber),
                    pinHash,
                    String(importedClient.name),
                    String(importedClient.phone),
                    (BigInt(importedClient.balance) * 100n).toString()
                ]
            );
            const clientId = insertResult.rows[0]?.id;
            if (!clientId) return false;

            for (const transaction of importedClient.transactions) {
                if (
                    !["deposit", "withdraw"].includes(transaction.type)
                    || !Number.isSafeInteger(transaction.amount)
                    || transaction.amount <= 0
                ) {
                    throw new Error(`Account ${importedClient.accountNumber} has an invalid transaction.`);
                }

                await client.query(
                    `INSERT INTO transactions (
                        id, client_id, type, amount_cents, balance_after_cents,
                        idempotency_key, created_at
                     )
                     VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
                    [
                        randomUUID(),
                        clientId,
                        transaction.type,
                        (BigInt(transaction.amount) * 100n).toString(),
                        randomUUID(),
                        new Date(transaction.date)
                    ]
                );
            }
            return true;
        });

        console.log(`${imported ? "Imported" : "Skipped existing"} account ${importedClient.accountNumber}`);
    }
}

importClients()
    .then(() => closePool())
    .catch(async (error) => {
        console.error(error.message);
        await closePool().catch(() => {});
        process.exitCode = 1;
    });

