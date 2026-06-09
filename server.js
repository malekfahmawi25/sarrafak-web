const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
    authenticate,
    clearLoginFailures,
    createSession,
    deleteExpiredSecurityRecords,
    deleteSession,
    getSessionClient,
    isLoginBlocked,
    loginThrottleKeys,
    performTransaction,
    recordAuditEvent,
    recordLoginFailure
} = require("./banking");
const { closePool, query } = require("./db");
const { hashPrivateValue, normalizePin, validateSecurityConfig } = require("./security");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 4173;
const ROOT_DIR = __dirname;
const QUICK_AMOUNTS = new Set([20, 50, 100, 200, 400, 600, 800, 1000]);
const PUBLIC_FILES = new Set(["index.html", "app.js", "config.js", "styles.css"]);
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const COOKIE_NAME = IS_PRODUCTION ? "__Host-id" : "id";
const ALLOW_SELF_DEPOSIT = process.env.ALLOW_SELF_DEPOSIT === "true";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const activeLoginKeys = new Set();

const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
const allowedOrigins = new Set(configuredOrigins);
if (process.env.RENDER_EXTERNAL_URL) {
    allowedOrigins.add(process.env.RENDER_EXTERNAL_URL.replace(/\/$/, ""));
}
if (!IS_PRODUCTION) {
    allowedOrigins.add(`http://localhost:${PORT}`);
    allowedOrigins.add(`http://127.0.0.1:${PORT}`);
}

const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
};

function securityHeaders(request) {
    const headers = {
        "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
    };

    if (IS_PRODUCTION || request.headers["x-forwarded-proto"] === "https") {
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
    }
    return headers;
}

function corsHeaders(request) {
    const origin = String(request.headers.origin || "").replace(/\/$/, "");
    if (!origin || !originIsAllowed(request)) return {};

    return {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin"
    };
}

function sendJson(request, response, statusCode, data, extraHeaders = {}) {
    response.writeHead(statusCode, {
        ...securityHeaders(request),
        ...corsHeaders(request),
        ...extraHeaders,
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify(data));
}

function isDevelopmentLoopbackOrigin(origin) {
    if (IS_PRODUCTION || !origin) return false;

    try {
        const url = new URL(origin);
        return url.protocol === "http:"
            && ["localhost", "127.0.0.1"].includes(url.hostname);
    } catch {
        return false;
    }
}

function originIsAllowed(request) {
    const origin = String(request.headers.origin || "").replace(/\/$/, "");
    return !origin || allowedOrigins.has(origin) || isDevelopmentLoopbackOrigin(origin);
}

function requestIsTrustedAjax(request) {
    return request.headers["x-requested-with"] === "Sarrafak-Web";
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        const contentType = request.headers["content-type"] || "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
            reject(new Error("UNSUPPORTED_CONTENT_TYPE"));
            return;
        }

        let body = "";
        request.on("data", (chunk) => {
            body += chunk;
            if (body.length > 16_384) {
                reject(new Error("REQUEST_TOO_LARGE"));
                request.destroy();
            }
        });
        request.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("INVALID_JSON"));
            }
        });
        request.on("error", reject);
    });
}

function parseCookies(request) {
    const result = {};
    for (const item of String(request.headers.cookie || "").split(";")) {
        const separator = item.indexOf("=");
        if (separator < 0) continue;
        const name = item.slice(0, separator).trim();
        const value = item.slice(separator + 1).trim();
        if (name) result[name] = value;
    }
    return result;
}

function getSessionToken(request) {
    return parseCookies(request)[COOKIE_NAME] || "";
}

function sessionCookie(token, maxAgeSeconds) {
    const secure = IS_PRODUCTION ? "; Secure" : "";
    const partitioned = IS_PRODUCTION ? "; Partitioned" : "";
    const sameSite = IS_PRODUCTION ? "None" : "Strict";
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAgeSeconds}${secure}${partitioned}`;
}

function clearSessionCookie() {
    const secure = IS_PRODUCTION ? "; Secure" : "";
    const partitioned = IS_PRODUCTION ? "; Partitioned" : "";
    const sameSite = IS_PRODUCTION ? "None" : "Strict";
    return `${COOKIE_NAME}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}${partitioned}`;
}

function getClientIp(request) {
    if (TRUST_PROXY) {
        const forwarded = String(request.headers["x-forwarded-for"] || "")
            .split(",")[0]
            .trim();
        if (forwarded) return forwarded;
    }
    return request.socket.remoteAddress || "unknown";
}

function capabilities() {
    return { selfDeposit: ALLOW_SELF_DEPOSIT };
}

async function requireClient(request, response) {
    const token = getSessionToken(request);
    const session = await getSessionClient(token);

    if (!session) {
        sendJson(request, response, 401, { message: "انتهت جلسة الدخول. سجل الدخول مرة أخرى." }, {
            "Set-Cookie": clearSessionCookie()
        });
        return null;
    }

    return { token, clientId: session.id, client: session.publicClient };
}

async function handleLogin(request, response) {
    const { accountNumber: rawAccountNumber, pinCode: rawPinCode } = await readJson(request);
    const accountNumber = String(rawAccountNumber || "").trim();
    const ipAddress = getClientIp(request);
    const throttleKeys = loginThrottleKeys(accountNumber || "invalid", ipAddress);

    if (throttleKeys.some((key) => activeLoginKeys.has(key))) {
        sendJson(request, response, 429, { message: "توجد محاولة دخول قيد التنفيذ. حاول بعد قليل." }, {
            "Retry-After": "2"
        });
        return;
    }
    throttleKeys.forEach((key) => activeLoginKeys.add(key));

    try {
        if (await isLoginBlocked(throttleKeys)) {
            sendJson(request, response, 429, {
                message: "تم إيقاف محاولات الدخول مؤقتاً. حاول بعد 15 دقيقة."
            }, { "Retry-After": "900" });
            return;
        }

        let pinCode;
        try {
            pinCode = normalizePin(rawPinCode);
        } catch {
            await recordLoginFailure(throttleKeys);
            sendJson(request, response, 401, { message: "رقم الحساب أو الرقم السري غير صحيح." });
            return;
        }

        const validAccount = /^\d{4,32}$/.test(accountNumber);
        const clientId = validAccount ? await authenticate(accountNumber, pinCode) : null;
        if (!clientId) {
            if (!validAccount) await authenticate("invalid-account", pinCode);
            await recordLoginFailure(throttleKeys);
            await recordAuditEvent(null, "login_failed", {
                accountKey: hashPrivateValue("account", accountNumber),
                ipKey: hashPrivateValue("ip", ipAddress)
            });
            sendJson(request, response, 401, { message: "رقم الحساب أو الرقم السري غير صحيح." });
            return;
        }

        await clearLoginFailures(throttleKeys);
        const session = await createSession(clientId);
        const sessionClient = await getSessionClient(session.token);
        await recordAuditEvent(clientId, "login_success", {
            ipKey: hashPrivateValue("ip", ipAddress)
        });

        sendJson(request, response, 200, {
            client: sessionClient.publicClient,
            capabilities: capabilities()
        }, {
            "Set-Cookie": sessionCookie(session.token, session.ttlSeconds)
        });
    } finally {
        throttleKeys.forEach((key) => activeLoginKeys.delete(key));
    }
}

async function handleApi(request, response, pathname) {
    if (request.method === "GET" && pathname === "/api/health") {
        try {
            await query("SELECT 1");
            sendJson(request, response, 200, { ok: true });
        } catch {
            sendJson(request, response, 503, { ok: false });
        }
        return;
    }

    if (!originIsAllowed(request)) {
        sendJson(request, response, 403, { message: "مصدر الطلب غير مسموح." });
        return;
    }

    if (request.method === "POST" && !requestIsTrustedAjax(request)) {
        sendJson(request, response, 403, { message: "تعذر التحقق من مصدر الطلب." });
        return;
    }

    if (request.method === "POST" && pathname === "/api/login") {
        await handleLogin(request, response);
        return;
    }

    if (request.method === "POST" && pathname === "/api/logout") {
        const token = getSessionToken(request);
        await deleteSession(token);
        sendJson(request, response, 200, { ok: true }, {
            "Set-Cookie": clearSessionCookie()
        });
        return;
    }

    if (request.method === "GET" && pathname === "/api/me") {
        const session = await requireClient(request, response);
        if (session) {
            sendJson(request, response, 200, {
                client: session.client,
                capabilities: capabilities()
            });
        }
        return;
    }

    if (request.method === "POST" && pathname === "/api/transactions") {
        const session = await requireClient(request, response);
        if (!session) return;

        const idempotencyKey = String(request.headers["idempotency-key"] || "");
        if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
            sendJson(request, response, 400, { message: "تعذر التحقق من معرّف العملية." });
            return;
        }

        const { action, amount: rawAmount } = await readJson(request);
        const amount = Number(rawAmount);
        const validActions = new Set(["deposit", "withdraw", "quick"]);

        if (!validActions.has(action) || !Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000) {
            sendJson(request, response, 400, { message: "أدخل مبلغاً صحيحاً ضمن الحد المسموح." });
            return;
        }
        if (action === "deposit" && !ALLOW_SELF_DEPOSIT) {
            sendJson(request, response, 403, { message: "الإيداع الذاتي غير متاح في الوضع الحقيقي." });
            return;
        }
        if (action === "withdraw" && amount % 5 !== 0) {
            sendJson(request, response, 400, { message: "يجب أن يكون مبلغ السحب من مضاعفات الرقم 5." });
            return;
        }
        if (action === "quick" && !QUICK_AMOUNTS.has(amount)) {
            sendJson(request, response, 400, { message: "اختر مبلغاً من قائمة السحب السريع." });
            return;
        }

        try {
            const result = await performTransaction(
                session.clientId,
                action,
                amount,
                idempotencyKey
            );
            const isWithdrawal = action === "withdraw" || action === "quick";
            sendJson(request, response, 200, {
                client: result.client,
                message: `${isWithdrawal ? "تم سحب" : "تم إيداع"} ${amount} د.أ`
            });
        } catch (error) {
            if (error.message === "INSUFFICIENT_FUNDS") {
                sendJson(request, response, 400, { message: "المبلغ المطلوب أكبر من رصيدك المتاح." });
                return;
            }
            if (error.message === "IDEMPOTENCY_CONFLICT") {
                sendJson(request, response, 409, { message: "معرّف العملية مستخدم مسبقاً لعملية مختلفة." });
                return;
            }
            throw error;
        }
        return;
    }

    sendJson(request, response, 404, { message: "المسار المطلوب غير موجود." });
}

function serveStatic(request, response, pathname) {
    const requestedPath = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.resolve(ROOT_DIR, requestedPath);

    if (!PUBLIC_FILES.has(requestedPath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(request, response, 404, { message: "الصفحة المطلوبة غير موجودة." });
        return;
    }

    response.writeHead(200, {
        ...securityHeaders(request),
        "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": requestedPath === "index.html" || requestedPath === "config.js"
            ? "no-cache"
            : "public, max-age=3600"
    });
    fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
    request.setTimeout(15_000, () => request.destroy());

    try {
        const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname);

        if (request.method === "OPTIONS" && pathname.startsWith("/api/")) {
            if (!originIsAllowed(request)) {
                sendJson(request, response, 403, { message: "مصدر الطلب غير مسموح." });
                return;
            }
            response.writeHead(204, {
                ...securityHeaders(request),
                ...corsHeaders(request),
                "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key, X-Requested-With",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Max-Age": "600"
            });
            response.end();
            return;
        }

        if (pathname.startsWith("/api/")) {
            await handleApi(request, response, pathname);
        } else if (request.method === "GET" || request.method === "HEAD") {
            serveStatic(request, response, pathname);
        } else {
            sendJson(request, response, 405, { message: "طريقة الطلب غير مسموحة." });
        }
    } catch (error) {
        console.error("Request failed:", error.message);
        if (!response.headersSent) {
            const clientError = new Set([
                "INVALID_JSON",
                "REQUEST_TOO_LARGE",
                "UNSUPPORTED_CONTENT_TYPE"
            ]).has(error.message);
            sendJson(request, response, clientError ? 400 : 500, {
                message: clientError ? "بيانات الطلب غير صحيحة." : "حدث خطأ في الخادم. حاول مرة أخرى."
            });
        } else {
            response.end();
        }
    }
});

async function start() {
    validateSecurityConfig();
    if (IS_PRODUCTION && allowedOrigins.size === 0) {
        throw new Error("At least one allowed origin is required in production.");
    }
    await query("SELECT 1");
    await deleteExpiredSecurityRecords();
    const cleanupTimer = setInterval(() => {
        deleteExpiredSecurityRecords().catch((error) => {
            console.error("Security record cleanup failed:", error.message);
        });
    }, 60 * 60 * 1000);
    cleanupTimer.unref();

    server.listen(PORT, HOST, () => {
        console.log(`Sarrafak is running at http://localhost:${PORT}`);
        for (const addresses of Object.values(os.networkInterfaces())) {
            for (const address of addresses || []) {
                if (address.family === "IPv4" && !address.internal) {
                    console.log(`Open on another device: http://${address.address}:${PORT}`);
                }
            }
        }
    });
}

async function shutdown() {
    server.close();
    await closePool();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((error) => {
    console.error("Server startup failed:", error.message);
    process.exitCode = 1;
});
