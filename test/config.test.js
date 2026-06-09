const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const configSource = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");

function apiOriginFor(hostname, protocol = "https:") {
    const window = { location: { hostname, protocol } };
    vm.runInNewContext(configSource, { window, Set });
    return window.SARRAFAK_API_ORIGIN;
}

test("local previews use the local Node server", () => {
    assert.equal(apiOriginFor("127.0.0.1", "http:"), "http://127.0.0.1:3000");
    assert.equal(apiOriginFor("localhost", "http:"), "http://localhost:3000");
});

test("GitHub Pages uses the Render API", () => {
    assert.equal(
        apiOriginFor("malekfahmawi25.github.io"),
        "https://sarrafak-web.onrender.com"
    );
});

test("Render uses its own origin", () => {
    assert.equal(apiOriginFor("sarrafak-web.onrender.com"), "");
});
