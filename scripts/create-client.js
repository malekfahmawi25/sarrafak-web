const { randomUUID } = require("node:crypto");
const { closePool, query } = require("../db");
const { hashPin, normalizePin } = require("../security");

function required(name) {
    const value = String(process.env[name] || "").trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
}

async function createClient() {
    const accountNumber = required("NEW_ACCOUNT_NUMBER");
    const name = required("NEW_CLIENT_NAME");
    const phone = required("NEW_CLIENT_PHONE");
    const pinCode = normalizePin(required("NEW_CLIENT_PIN"));
    const balance = Number(process.env.NEW_CLIENT_BALANCE || 0);

    if (!/^\d{4,32}$/.test(accountNumber)) {
        throw new Error("NEW_ACCOUNT_NUMBER must contain between 4 and 32 digits.");
    }
    if (!Number.isSafeInteger(balance) || balance < 0) {
        throw new Error("NEW_CLIENT_BALANCE must be a non-negative integer.");
    }

    const pinHash = await hashPin(pinCode);
    await query(
        `INSERT INTO clients (
            id, account_number, pin_hash, name, phone, balance_cents
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            randomUUID(),
            accountNumber,
            pinHash,
            name,
            phone,
            (BigInt(balance) * 100n).toString()
        ]
    );

    console.log(`Created account ${accountNumber}.`);
}

createClient()
    .then(() => closePool())
    .catch(async (error) => {
        console.error(error.message);
        await closePool().catch(() => {});
        process.exitCode = 1;
    });

