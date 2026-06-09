const REQUEST_TIMEOUT_MS = 15000;
const configuredApiOrigin = window.SARRAFAK_API_ORIGIN?.trim().replace(/\/$/, "");
const isLocalPreview =
  ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
  window.location.port !== "4173";
const isUnconfiguredGitHubPages =
  window.location.hostname.endsWith("github.io") && !configuredApiOrigin;
const API_ORIGIN =
  configuredApiOrigin ||
  (isLocalPreview
    ? `${window.location.protocol}//${window.location.hostname}:4173`
    : window.location.origin);

const loginView = document.querySelector("#loginView");
const dashboardView = document.querySelector("#dashboardView");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const logoutButton = document.querySelector("#logoutButton");
const revealPin = document.querySelector("#revealPin");
const modalBackdrop = document.querySelector("#modalBackdrop");
const closeModalButton = document.querySelector("#closeModal");
const transactionForm = document.querySelector("#transactionForm");
const transactionAmount = document.querySelector("#transactionAmount");
const transactionError = document.querySelector("#transactionError");
const quickAmounts = document.querySelector("#quickAmounts");
const amountField = document.querySelector("#amountField");
const confirmTransaction = document.querySelector("#confirmTransaction");
const toast = document.querySelector("#toast");
const connectionStatus = document.querySelector("#connectionStatus");
const connectionStatusText = document.querySelector("#connectionStatusText");

let currentClient = null;
let currentAction = null;
let toastTimer = null;
let capabilities = { selfDeposit: false };
let transactionPending = false;
let loginPending = false;

async function apiRequest(path, options = {}) {
  if (isUnconfiguredGitHubPages) {
    setConnectionStatus(false);
    throw new Error(
      "نسخة GitHub Pages غير مدعومة في الوضع الآمن. افتح رابط الخادم مباشرة.",
    );
  }

  const headers = {
    "X-Requested-With": "Sarrafak-Web",
    ...(options.headers || {}),
  };
  if (options.body) headers["Content-Type"] = "application/json";

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...options,
      headers,
      credentials: "include",
      signal: controller.signal,
    });
  } catch (error) {
    setConnectionStatus(false);
    if (error.name === "AbortError") {
      throw new Error("انتهت مهلة الاتصال بالخادم. حاول مرة أخرى.");
    }
    throw new Error(
      "تعذر الاتصال بالخادم. تأكد أن الجهاز المستضيف يعمل ومتصل بالشبكة.",
    );
  } finally {
    clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") clearSession();
    throw new Error(data.message || "تعذر إكمال الطلب.");
  }

  setConnectionStatus(true);
  return data;
}

function setConnectionStatus(isConnected) {
  connectionStatus.classList.toggle("offline", !isConnected);
  connectionStatusText.textContent = isConnected ? "متصل بالخادم" : "الخادم غير متصل";
}

function clearSession() {
  currentClient = null;
  capabilities = { selfDeposit: false };
}

function useSessionResult(result) {
  currentClient = result.client;
  capabilities = result.capabilities || { selfDeposit: false };
  document
    .querySelector('[data-action="deposit"]')
    .classList.toggle("hidden", !capabilities.selfDeposit);
}

function formatMoney(amount) {
  return new Intl.NumberFormat("ar-JO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ar-JO", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

function updateDashboard() {
  if (!currentClient) return;

  document.querySelector("#clientFirstName").textContent =
    currentClient.name.split(" ")[0];
  document.querySelector("#balanceAmount").textContent = formatMoney(
    currentClient.balance,
  );
  document.querySelector("#maskedAccount").textContent =
    `•••• ${currentClient.accountNumber.slice(-4)}`;

  const activityList = document.querySelector("#activityList");
  const transactions = [...currentClient.transactions]
    .sort((first, second) => new Date(second.date) - new Date(first.date))
    .slice(0, 5);

  if (!transactions.length) {
    activityList.innerHTML =
      '<div class="empty-state">لا توجد عمليات حتى الآن</div>';
    return;
  }

  activityList.innerHTML = transactions
    .map((transaction) => {
      const isDeposit = transaction.type === "deposit";
      return `
            <div class="activity-item">
                <span class="activity-dot">${isDeposit ? "＋" : "−"}</span>
                <span>
                    <strong>${isDeposit ? "إيداع نقدي" : "سحب نقدي"}</strong>
                    <small>${formatDate(transaction.date)}</small>
                </span>
                <span class="activity-amount ${isDeposit ? "" : "withdraw"}">
                    ${isDeposit ? "+" : "−"}${formatMoney(transaction.amount)} د.أ
                </span>
            </div>
        `;
    })
    .join("");
}

function showDashboard() {
  loginView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
  logoutButton.classList.remove("hidden");
  document.querySelector("#todayDate").textContent = new Intl.DateTimeFormat(
    "ar-JO",
    {
      weekday: "long",
      day: "numeric",
      month: "long",
    },
  ).format(new Date());
  updateDashboard();
}

function showLogin() {
  loginForm.reset();
  loginError.textContent = "";
  loginView.classList.remove("hidden");
  dashboardView.classList.add("hidden");
  logoutButton.classList.add("hidden");
}

function openModal(action) {
  currentAction = action;
  transactionForm.reset();
  transactionError.textContent = "";
  quickAmounts.classList.add("hidden");
  amountField.classList.remove("hidden");
  confirmTransaction.classList.remove("hidden");

  const modalIcon = document.querySelector("#modalIcon");
  const modalTitle = document.querySelector("#modalTitle");
  const modalDescription = document.querySelector("#modalDescription");

  if (action === "deposit") {
    modalIcon.textContent = "＋";
    modalTitle.textContent = "إيداع مبلغ";
    modalDescription.textContent = "أدخل المبلغ الذي تريد إضافته إلى حسابك";
  } else if (action === "withdraw") {
    modalIcon.textContent = "−";
    modalTitle.textContent = "سحب عادي";
    modalDescription.textContent = "أدخل مبلغًا موجبًا ومن مضاعفات الرقم 5";
  } else if (action === "quick") {
    modalIcon.textContent = "⚡";
    modalTitle.textContent = "سحب سريع";
    modalDescription.textContent = "اختر المبلغ الذي تريد سحبه";
    amountField.classList.add("hidden");
    quickAmounts.classList.remove("hidden");
    confirmTransaction.classList.add("hidden");
    quickAmounts.innerHTML = [20, 50, 100, 200, 400, 600, 800, 1000]
      .map(
        (amount) =>
          `<button type="button" data-amount="${amount}">${amount} د.أ</button>`,
      )
      .join("");
  } else {
    modalIcon.textContent = "◫";
    modalTitle.textContent = "رصيدك الحالي";
    modalDescription.textContent = `${formatMoney(currentClient.balance)} د.أ`;
    amountField.classList.add("hidden");
    confirmTransaction.classList.add("hidden");
  }

  modalBackdrop.classList.remove("hidden");
  if (action === "deposit" || action === "withdraw") {
    setTimeout(() => transactionAmount.focus(), 50);
  }
}

function closeModal() {
  modalBackdrop.classList.add("hidden");
  currentAction = null;
}

function showToast(title, message) {
  clearTimeout(toastTimer);
  document.querySelector("#toastTitle").textContent = title;
  document.querySelector("#toastMessage").textContent = message;
  toast.classList.remove("hidden");
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3500);
}

async function performTransaction(amount) {
  if (transactionPending) return;
  transactionPending = true;
  transactionError.textContent = "";
  confirmTransaction.disabled = true;

  try {
    const result = await apiRequest("/api/transactions", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action: currentAction, amount }),
    });
    const isWithdrawal =
      currentAction === "withdraw" || currentAction === "quick";
    currentClient = result.client;
    updateDashboard();
    closeModal();
    showToast(
      "تمت العملية بنجاح",
      `${isWithdrawal ? "تم سحب" : "تم إيداع"} ${formatMoney(amount)} د.أ`,
    );
  } catch (error) {
    transactionError.textContent = error.message;
  } finally {
    transactionPending = false;
    confirmTransaction.disabled = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loginPending) return;
  loginPending = true;
  loginError.textContent = "";
  const submitButton = loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;

  const accountNumber = document.querySelector("#accountNumber").value.trim();
  const pinCode = document.querySelector("#pinCode").value.trim();

  try {
    const result = await apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({ accountNumber, pinCode }),
    });
    useSessionResult(result);
    showDashboard();
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    loginPending = false;
    submitButton.disabled = false;
  }
});

revealPin.addEventListener("click", () => {
  const pinInput = document.querySelector("#pinCode");
  pinInput.type = pinInput.type === "password" ? "text" : "password";
});

logoutButton.addEventListener("click", async () => {
  try {
    await apiRequest("/api/logout", { method: "POST" });
  } catch {
    // The local session still needs to be cleared if the server is unavailable.
  }
  clearSession();
  showLogin();
});

closeModalButton.addEventListener("click", closeModal);

modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalBackdrop.classList.contains("hidden"))
    closeModal();
});

document.querySelectorAll(".operation-card").forEach((button) => {
  button.addEventListener("click", () => openModal(button.dataset.action));
});

quickAmounts.addEventListener("click", (event) => {
  const button = event.target.closest("[data-amount]");
  if (button) performTransaction(Number(button.dataset.amount));
});

transactionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  performTransaction(Number(transactionAmount.value));
});

async function restoreSession() {
  try {
    const result = await apiRequest("/api/me");
    useSessionResult(result);
    showDashboard();
  } catch {
    clearSession();
    showLogin();
  }
}

restoreSession();

apiRequest("/api/health").catch(() => {
  setConnectionStatus(false);
});

setInterval(async () => {
  if (!currentClient) return;

  try {
    const result = await apiRequest("/api/me");
    useSessionResult(result);
    updateDashboard();
  } catch {
    clearSession();
    showLogin();
  }
}, 30000);
