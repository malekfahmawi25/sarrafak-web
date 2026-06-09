const {
    createHash,
    createHmac,
    randomBytes,
    scrypt,
    timingSafeEqual
} = require("node:crypto");
const { promisify } = require("node:util");

const scryptAsync = promisify(scrypt);
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

function requireSecret(name) {
    const value = process.env[name] || "";
    if (value.length < 32) {
        throw new Error(`${name} must contain at least 32 characters.`);
    }
    return value;
}

function normalizePin(pin) {
    const value = String(pin || "").trim();
    if (!/^\d{4,12}$/.test(value)) {
        throw new Error("PIN must contain between 4 and 12 digits.");
    }
    return value;
}

function prehashPin(pin) {
    return createHmac("sha256", requireSecret("PIN_PEPPER"))
        .update(normalizePin(pin), "utf8")
        .digest();
}

async function derivePinKey(pin, salt) {
    return scryptAsync(prehashPin(pin), salt, SCRYPT_KEY_LENGTH, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAX_MEMORY
    });
}

async function hashPin(pin) {
    const salt = randomBytes(16);
    const derivedKey = await derivePinKey(pin, salt);
    return [
        "scrypt",
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString("base64url"),
        derivedKey.toString("base64url")
    ].join("$");
}

async function verifyPin(pin, encodedHash) {
    try {
        const [algorithm, n, r, p, saltValue, keyValue, extra] = String(encodedHash || "").split("$");
        if (
            algorithm !== "scrypt"
            || Number(n) !== SCRYPT_N
            || Number(r) !== SCRYPT_R
            || Number(p) !== SCRYPT_P
            || extra !== undefined
        ) {
            return false;
        }

        const expectedKey = Buffer.from(keyValue, "base64url");
        const actualKey = await derivePinKey(pin, Buffer.from(saltValue, "base64url"));
        return expectedKey.length === actualKey.length && timingSafeEqual(expectedKey, actualKey);
    } catch {
        return false;
    }
}

function createSessionToken() {
    return randomBytes(32).toString("base64url");
}

function hashToken(token) {
    return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function hashPrivateValue(type, value) {
    return createHmac("sha256", requireSecret("APP_SECRET"))
        .update(`${type}:${String(value || "")}`, "utf8")
        .digest("hex");
}

function validateSecurityConfig() {
    requireSecret("APP_SECRET");
    requireSecret("PIN_PEPPER");
}

module.exports = {
    createSessionToken,
    hashPin,
    hashPrivateValue,
    hashToken,
    normalizePin,
    validateSecurityConfig,
    verifyPin
};
