const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_SECRET = "test-app-secret-that-is-at-least-32-characters";
process.env.PIN_PEPPER = "test-pin-pepper-that-is-at-least-32-characters";

const {
    createSessionToken,
    hashPin,
    hashPrivateValue,
    hashToken,
    verifyPin
} = require("../security");

test("PIN hashes verify only the correct PIN", async () => {
    const hash = await hashPin("1234");
    assert.equal(await verifyPin("1234", hash), true);
    assert.equal(await verifyPin("9999", hash), false);
    assert.equal(hash.includes("1234"), false);
});

test("session tokens are random and only their hashes need storage", () => {
    const first = createSessionToken();
    const second = createSessionToken();
    assert.notEqual(first, second);
    assert.equal(first.length, 43);
    assert.match(hashToken(first), /^[a-f0-9]{64}$/);
});

test("private throttle keys do not expose their input", () => {
    const value = hashPrivateValue("account", "1001");
    assert.match(value, /^[a-f0-9]{64}$/);
    assert.equal(value.includes("1001"), false);
});

