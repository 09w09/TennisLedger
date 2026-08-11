(() => {
  "use strict";

  const config = window.TENNIS_LEDGER_CONFIG ?? {};
  const SUPABASE_PLACEHOLDER = "YOUR_PROJECT";
  const KEY_PLACEHOLDER = "YOUR_PUBLISHABLE_KEY";

  const state = {
    client: null,
    session: null,
    currentLedger: null,
    members: [],
    transactions: [],
    adjustingMember: null,
    toastTimer: null
  };

  const $ = (id) => document.getElementById(id);

  const views = {
    setup: $("setup-view"),
    login: $("login-view"),
    app: $("app-view"),
    ledgerList: $("ledger-list-view"),
    ledgerDetail: $("ledger-detail-view")
  };

  function showOnly(viewName) {
    [views.setup, views.login, views.app].forEach((el) => el.classList.add("hidden"));
    views[viewName].classList.remove("hidden");
  }

  function setButtonBusy(button, busy, busyText = "处理中…") {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  function showToast(message, type = "success") {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.toggle("error", type === "error");
    toast.classList.remove("hidden");

    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 3200);
  }

  function setLoginError(message = "") {
    const el = $("login-error");
    el.textContent = message;
    el.classList.toggle("hidden", !message);
  }

  function isConfigured() {
    return Boolean(
      config.supabaseUrl &&
      config.supabasePublishableKey &&
      !config.supabaseUrl.includes(SUPABASE_PLACEHOLDER) &&
      !config.supabasePublishableKey.includes(KEY_PLACEHOLDER)
    );
  }

  function formatMoney(value, withSymbol = true) {
    const number = Number(value || 0);
    const text = new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(number);
    return withSymbol ? `¥${text}` : text;
  }

  function formatSignedAmount(value) {
    const number = Number(value || 0);
    if (number > 0) return `+${formatMoney(number, false)}`;
    return formatMoney(number, false);
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value));
  }

  function normalizeError(error) {
    const message = error?.message || String(error || "未知错误");
    if (message.includes("Invalid login credentials")) return "邮箱或密码错误。";
    if (message.includes("Email not confirmed")) return "该账号的邮箱还没有确认。";
    if (message.includes("duplicate key") && message.includes("ledgers_active_name_unique")) return "已经存在同名账本。";
    if (message.includes("duplicate key") && message.includes("members_ledger_id_name_key")) return "这个账本里已经存在同名用户。";
    if (message.includes("Only administrators")) return "当前账号没有管理员权限。";
    return message;
  }

  function createTextElement(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  }

  async function ensureAdmin() {
    const { data, error } = await state.client
      .from("admins")
      .select("user_id")
      .eq("user_id", state.session.user.id)
      .maybeSingle();

    if (error) throw error;
    return Boolean(data);
  }

  async function enterApp() {
    const isAdmin = await ensureAdmin();
    if (!isAdmin) {
      await state.client.auth.signOut();
      state.session = null;
      showOnly("login");
      setLoginError("这个账号不是管理员。请先按 README 把该用户 UID 加入 admins 表。");
      return;
    }

    $("admin-email").textContent = state.session.user.email || "管理员";
    showOnly("app");
    await showLedgerList();
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginError();

    const button = $("login-button");
    setButtonBusy(button, true, "登录中…");

    try {
      const email = $("email").value.trim();
      const password = $("password").value;
      const { data, error } = await state.client.auth.signInWithPassword({ email, password });
      if (error) throw error;

      state.session = data.session;
      await enterApp();
      $("password").value = "";
    } catch (error) {
      setLoginError(normalizeError(error));
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function handleLogout() {
    await state.client.auth.signOut();
    state.session = null;
    state.currentLedger = null;
    state.members = [];
    state.transactions = [];
    setLoginError();
    showOnly("login");
  }

  function renderLedgers(ledgers) {
    const list = $("ledger-list");
    list.replaceChildren();
    $("ledger-empty").classList.toggle("hidden", ledgers.length !== 0);

    ledgers.forEach((ledger) => {
      const card = document.createElement("article");
      card.className = "ledger-card";

      const title = createTextElement("h3", "", ledger.name);
      const meta = createTextElement("div", "ledger-card-meta", `创建于 ${formatDate(ledger.created_at)}`);
      const openButton = createTextElement("button", "primary", "进入账本");
      openButton.type = "button";
      openButton.addEventListener("click", () => openLedger(ledger));

      const textGroup = document.createElement("div");
      textGroup.append(title, meta);
      card.append(textGroup, openButton);
      list.append(card);
    });
  }

  async function loadLedgers() {
    const { data, error } = await state.client
      .from("ledgers")
      .select("id,name,created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (error) throw error;
    renderLedgers(data || []);
  }

  async function showLedgerList() {
    state.currentLedger = null;
    $("page-title").textContent = "账本管理";
    views.ledgerDetail.classList.add("hidden");
    views.ledgerList.classList.remove("hidden");

    try {
      await loadLedgers();
    } catch (error) {
      showToast(normalizeError(error), "error");
    }
  }

  async function handleCreateLedger(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type='submit']");
    const name = $("ledger-name").value.trim();
    if (!name) return;

    setButtonBusy(button, true, "创建中…");
    try {
      const { error } = await state.client.rpc("create_ledger", { p_name: name });
      if (error) throw error;
      $("ledger-name").value = "";
      await loadLedgers();
      showToast("账本已创建。", "success");
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function openLedger(ledger) {
    state.currentLedger = ledger;
    $("page-title").textContent = ledger.name;
    $("ledger-title").textContent = ledger.name;
    views.ledgerList.classList.add("hidden");
    views.ledgerDetail.classList.remove("hidden");
    await refreshLedgerDetail();
  }

  function renderMembers() {
    const list = $("member-list");
    list.replaceChildren();
    $("member-empty").classList.toggle("hidden", state.members.length !== 0);

    const total = state.members.reduce((sum, member) => sum + Number(member.balance), 0);
    $("total-balance").textContent = formatMoney(total);

    state.members.forEach((member, index) => {
      const row = document.createElement("div");
      row.className = "member-row";

      const nameWrap = document.createElement("div");
      const rank = createTextElement("span", "member-rank", String(index + 1).padStart(2, "0"));
      const name = createTextElement("span", "member-name", member.name);
      nameWrap.append(rank, name);

      const balance = createTextElement("div", "member-balance", formatMoney(member.balance));
      if (Number(member.balance) < 0) balance.classList.add("negative");

      const adjustButton = createTextElement("button", "ghost", "调整余额");
      adjustButton.type = "button";
      adjustButton.addEventListener("click", () => openAdjustDialog(member));

      row.append(nameWrap, balance, adjustButton);
      list.append(row);
    });
  }

  function renderTransactions() {
    const tbody = $("transaction-list");
    tbody.replaceChildren();
    $("transaction-empty").classList.toggle("hidden", state.transactions.length !== 0);

    state.transactions.forEach((tx) => {
      const row = document.createElement("tr");
      const amount = Number(tx.amount);
      const values = [
        formatDate(tx.created_at),
        tx.member_name,
        formatSignedAmount(amount),
        formatMoney(tx.balance_before, false),
        formatMoney(tx.balance_after, false),
        tx.note || "—"
      ];

      values.forEach((value, index) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (index === 2) cell.className = amount >= 0 ? "amount-positive" : "amount-negative";
        if (index === 5) cell.classList.add("note-cell");
        row.append(cell);
      });

      tbody.append(row);
    });
  }

  async function loadMembers() {
    const { data, error } = await state.client
      .from("members")
      .select("id,ledger_id,name,balance,created_at")
      .eq("ledger_id", state.currentLedger.id)
      .order("balance", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) throw error;
    state.members = data || [];
    renderMembers();
  }

  async function loadTransactions() {
    const { data, error } = await state.client
      .from("transactions")
      .select("id,member_name,amount,balance_before,balance_after,note,created_at")
      .eq("ledger_id", state.currentLedger.id)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;
    state.transactions = data || [];
    renderTransactions();
  }

  async function refreshLedgerDetail() {
    try {
      await Promise.all([loadMembers(), loadTransactions()]);
    } catch (error) {
      showToast(normalizeError(error), "error");
    }
  }

  async function handleAddMember(event) {
    event.preventDefault();
    if (!state.currentLedger) return;

    const form = event.currentTarget;
    const button = form.querySelector("button[type='submit']");
    const name = $("member-name").value.trim();
    const initialBalance = Number($("member-balance").value);

    if (!name || !Number.isFinite(initialBalance)) return;

    setButtonBusy(button, true, "添加中…");
    try {
      const { error } = await state.client.rpc("add_member", {
        p_ledger_id: state.currentLedger.id,
        p_name: name,
        p_initial_balance: initialBalance
      });
      if (error) throw error;

      $("member-name").value = "";
      $("member-balance").value = "0";
      await refreshLedgerDetail();
      showToast("用户已添加。", "success");
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  function openAdjustDialog(member) {
    state.adjustingMember = member;
    $("adjust-member-name").textContent = member.name;
    $("adjust-current-balance").textContent = formatMoney(member.balance);
    $("adjust-amount").value = "";
    $("adjust-note").value = "";
    $("adjust-dialog").showModal();
    window.setTimeout(() => $("adjust-amount").focus(), 0);
  }

  function closeAdjustDialog() {
    state.adjustingMember = null;
    $("adjust-dialog").close();
  }

  async function handleAdjustBalance(event) {
    event.preventDefault();
    const member = state.adjustingMember;
    if (!member) return;

    const amount = Number($("adjust-amount").value);
    const note = $("adjust-note").value.trim();
    if (!Number.isFinite(amount) || amount === 0) {
      showToast("变动金额必须是非零数字。", "error");
      return;
    }

    const button = $("adjust-submit-button");
    setButtonBusy(button, true, "保存中…");
    try {
      const { error } = await state.client.rpc("adjust_balance", {
        p_member_id: member.id,
        p_amount: amount,
        p_note: note
      });
      if (error) throw error;

      closeAdjustDialog();
      await refreshLedgerDetail();
      showToast(`${member.name} 的余额已更新。`, "success");
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function handleDeleteLedger() {
    if (!state.currentLedger) return;
    const name = state.currentLedger.name;
    const confirmed = window.confirm(`确定删除账本「${name}」吗？\n\n这是软删除，数据库中的成员和历史记录不会被物理删除。`);
    if (!confirmed) return;

    const button = $("delete-ledger-button");
    setButtonBusy(button, true, "删除中…");
    try {
      const { error } = await state.client.rpc("delete_ledger", {
        p_ledger_id: state.currentLedger.id
      });
      if (error) throw error;

      await showLedgerList();
      showToast("账本已删除。", "success");
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function handleCopySummary() {
    if (!state.currentLedger) return;

    const lines = ["本群账单列表汇总："];
    state.members.forEach((member) => {
      lines.push(`${member.name}账单汇总：${formatMoney(member.balance, false)}`);
    });
    const total = state.members.reduce((sum, member) => sum + Number(member.balance), 0);
    lines.push("======");
    lines.push(`总账单汇总：${formatMoney(total, false)}`);

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      showToast("汇总已复制到剪贴板。", "success");
    } catch {
      showToast("浏览器没有允许访问剪贴板，请手动复制。", "error");
    }
  }

  function bindEvents() {
    $("login-form").addEventListener("submit", handleLogin);
    $("logout-button").addEventListener("click", handleLogout);
    $("create-ledger-form").addEventListener("submit", handleCreateLedger);
    $("back-button").addEventListener("click", showLedgerList);
    $("add-member-form").addEventListener("submit", handleAddMember);
    $("delete-ledger-button").addEventListener("click", handleDeleteLedger);
    $("copy-summary-button").addEventListener("click", handleCopySummary);
    $("adjust-form").addEventListener("submit", handleAdjustBalance);
    $("adjust-close-button").addEventListener("click", closeAdjustDialog);
    $("adjust-cancel-button").addEventListener("click", closeAdjustDialog);
  }

  async function init() {
    bindEvents();

    if (!isConfigured()) {
      showOnly("setup");
      return;
    }

    if (!window.supabase?.createClient) {
      showOnly("setup");
      $("setup-view").querySelector(".muted").textContent = "Supabase JS 加载失败，请检查网络后刷新页面。";
      return;
    }

    state.client = window.supabase.createClient(
      config.supabaseUrl,
      config.supabasePublishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      }
    );

    const { data, error } = await state.client.auth.getSession();
    if (error) {
      showOnly("login");
      setLoginError(normalizeError(error));
      return;
    }

    state.session = data.session;
    if (!state.session) {
      showOnly("login");
      return;
    }

    try {
      await enterApp();
    } catch (error) {
      await state.client.auth.signOut();
      state.session = null;
      showOnly("login");
      setLoginError(normalizeError(error));
    }
  }

  init();
})();
