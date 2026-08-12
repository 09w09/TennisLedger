(() => {
  "use strict";

  const config = window.TENNIS_LEDGER_CONFIG ?? {};
  const SUPABASE_PLACEHOLDER = "YOUR_PROJECT";
  const KEY_PLACEHOLDER = "YOUR_PUBLISHABLE_KEY";
  const TRANSACTION_PAGE_SIZE = 100;

  const state = {
    client: null,
    session: null,
    currentLedger: null,
    members: [],
    transactions: [],
    transactionsHasMore: false,
    detailRequestId: 0,
    detailReady: false,
    detailMutationPending: false,
    ledgerListRequestId: 0,
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
      button.dataset.busy = "true";
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      delete button.dataset.busy;
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

  function isPrivilegedKey() {
    const key = String(config.supabasePublishableKey || "");
    if (key.startsWith("sb_secret_")) return true;

    try {
      const payloadPart = key.split(".")[1];
      if (!payloadPart) return false;
      const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      const payload = JSON.parse(window.atob(padded));
      return payload.role === "service_role";
    } catch {
      return false;
    }
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

  function formatSummaryAmount(value) {
    const fixed = Number(value || 0).toFixed(2);
    return fixed.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
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

  function totalBalance() {
    const cents = state.members.reduce(
      (sum, member) => sum + Math.round(Number(member.balance) * 100),
      0
    );
    return cents / 100;
  }

  function syncDetailControls() {
    const disabled = !state.detailReady || state.detailMutationPending;
    const controls = [
      $("copy-summary-button"),
      $("delete-ledger-button"),
      $("add-member-form").querySelector("button[type='submit']"),
      $("load-more-transactions-button")
    ];
    controls.forEach((button) => {
      button.disabled = disabled || button.dataset.busy === "true";
    });
    $("member-list").querySelectorAll("button").forEach((button) => {
      button.disabled = disabled || button.dataset.busy === "true";
    });
  }

  function setDetailMutationPending(pending) {
    state.detailMutationPending = pending;
    $("back-button").disabled = pending;
    $("logout-button").disabled = pending;
    syncDetailControls();
  }

  function setDetailStatus(message = "", type = "loading") {
    const status = $("ledger-detail-status");
    state.detailReady = type === "ready";
    status.textContent = message;
    status.classList.toggle("hidden", !message);
    status.classList.toggle("error", type === "error");
    syncDetailControls();
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
    state.transactionsHasMore = false;
    state.detailRequestId += 1;
    state.detailReady = false;
    state.detailMutationPending = false;
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

  async function fetchLedgers() {
    const { data, error } = await state.client
      .from("ledgers")
      .select("id,name,created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async function refreshLedgerList() {
    const requestId = ++state.ledgerListRequestId;
    const ledgers = await fetchLedgers();
    if (requestId !== state.ledgerListRequestId) return false;
    renderLedgers(ledgers);
    return true;
  }

  async function showLedgerList({ force = false } = {}) {
    if (state.detailMutationPending && !force) return null;
    state.detailRequestId += 1;
    state.currentLedger = null;
    state.members = [];
    state.transactions = [];
    state.transactionsHasMore = false;
    state.detailReady = false;
    $("page-title").textContent = "账本管理";
    views.ledgerDetail.classList.add("hidden");
    views.ledgerList.classList.remove("hidden");
    $("ledger-list").replaceChildren();
    $("ledger-empty").classList.add("hidden");

    try {
      return await refreshLedgerList();
    } catch (error) {
      showToast(normalizeError(error), "error");
      return false;
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
      try {
        await refreshLedgerList();
        showToast("账本已创建。", "success");
      } catch (refreshError) {
        showToast(`账本已创建，但列表刷新失败，请勿重复提交：${normalizeError(refreshError)}`, "error");
      }
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function openLedger(ledger) {
    state.currentLedger = ledger;
    state.members = [];
    state.transactions = [];
    state.transactionsHasMore = false;
    setDetailStatus("正在加载账本数据…");
    $("member-name").value = "";
    $("member-balance").value = "0";
    $("page-title").textContent = ledger.name;
    $("ledger-title").textContent = ledger.name;
    views.ledgerList.classList.add("hidden");
    views.ledgerDetail.classList.remove("hidden");
    renderMembers();
    renderTransactions();
    await refreshLedgerDetail();
  }

  function renderMembers() {
    const list = $("member-list");
    list.replaceChildren();
    $("member-empty").classList.toggle("hidden", !state.detailReady || state.members.length !== 0);

    $("total-balance").textContent = state.detailReady ? formatMoney(totalBalance()) : "—";

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
      adjustButton.disabled = !state.detailReady || state.detailMutationPending;
      adjustButton.addEventListener("click", () => openAdjustDialog(member));

      row.append(nameWrap, balance, adjustButton);
      list.append(row);
    });
  }

  function renderTransactions() {
    const tbody = $("transaction-list");
    tbody.replaceChildren();
    $("transaction-empty").classList.toggle("hidden", !state.detailReady || state.transactions.length !== 0);
    $("load-more-transactions-button").classList.toggle("hidden", !state.detailReady || !state.transactionsHasMore);

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

  async function fetchMembers(ledgerId) {
    const { data, error } = await state.client
      .from("members")
      .select("id,ledger_id,name,balance,created_at")
      .eq("ledger_id", ledgerId)
      .order("balance", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async function fetchTransactions(ledgerId, beforeId = null) {
    let query = state.client
      .from("transactions")
      .select("id,member_name,amount,balance_before,balance_after,note,created_at")
      .eq("ledger_id", ledgerId)
      .order("id", { ascending: false })
      .limit(TRANSACTION_PAGE_SIZE + 1);

    if (beforeId !== null) query = query.lt("id", beforeId);
    const { data, error } = await query;

    if (error) throw error;
    const rows = data || [];
    return {
      items: rows.slice(0, TRANSACTION_PAGE_SIZE),
      hasMore: rows.length > TRANSACTION_PAGE_SIZE
    };
  }

  async function refreshLedgerDetail() {
    const ledgerId = state.currentLedger?.id;
    if (!ledgerId) return null;

    const requestId = ++state.detailRequestId;
    setDetailStatus("正在加载账本数据…");
    try {
      const [members, transactionPage] = await Promise.all([
        fetchMembers(ledgerId),
        fetchTransactions(ledgerId)
      ]);

      if (requestId !== state.detailRequestId || state.currentLedger?.id !== ledgerId) return null;
      state.members = members;
      state.transactions = transactionPage.items;
      state.transactionsHasMore = transactionPage.hasMore;
      setDetailStatus("", "ready");
      renderMembers();
      renderTransactions();
      return true;
    } catch (error) {
      if (requestId === state.detailRequestId) {
        setDetailStatus("账本数据加载失败。请返回列表后重新进入。", "error");
        showToast(normalizeError(error), "error");
      }
      return false;
    }
  }

  async function handleLoadMoreTransactions() {
    const ledgerId = state.currentLedger?.id;
    if (!ledgerId || !state.detailReady || state.detailMutationPending || !state.transactionsHasMore) return;

    const requestId = state.detailRequestId;
    const button = $("load-more-transactions-button");
    setButtonBusy(button, true, "加载中…");
    syncDetailControls();

    try {
      const oldestId = state.transactions.at(-1)?.id ?? null;
      const transactionPage = await fetchTransactions(ledgerId, oldestId);
      if (requestId !== state.detailRequestId || state.currentLedger?.id !== ledgerId) return;

      const existingIds = new Set(state.transactions.map((transaction) => transaction.id));
      state.transactions.push(...transactionPage.items.filter((transaction) => !existingIds.has(transaction.id)));
      state.transactionsHasMore = transactionPage.hasMore;
      renderTransactions();
    } catch (error) {
      if (requestId === state.detailRequestId) showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
      syncDetailControls();
    }
  }

  async function handleAddMember(event) {
    event.preventDefault();
    if (!state.currentLedger || !state.detailReady || state.detailMutationPending) return;

    const ledgerId = state.currentLedger.id;
    const form = event.currentTarget;
    const button = form.querySelector("button[type='submit']");
    const name = $("member-name").value.trim();
    const initialBalance = Number($("member-balance").value);

    if (!name || !Number.isFinite(initialBalance)) return;

    setButtonBusy(button, true, "添加中…");
    setDetailMutationPending(true);
    try {
      const { error } = await state.client.rpc("add_member", {
        p_ledger_id: ledgerId,
        p_name: name,
        p_initial_balance: initialBalance
      });
      if (error) throw error;

      if (state.currentLedger?.id === ledgerId) {
        $("member-name").value = "";
        $("member-balance").value = "0";
        const refreshed = await refreshLedgerDetail();
        if (state.currentLedger?.id === ledgerId && refreshed !== null) {
          showToast(refreshed ? "用户已添加。" : "用户已添加，但页面刷新失败，请勿重复提交，并重新进入账本。", refreshed ? "success" : "error");
        }
      }
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
      setDetailMutationPending(false);
    }
  }

  function openAdjustDialog(member) {
    if (!state.detailReady || state.detailMutationPending || member.ledger_id !== state.currentLedger?.id) return;
    state.adjustingMember = member;
    $("adjust-member-name").textContent = member.name;
    $("adjust-current-balance").textContent = formatMoney(member.balance);
    $("adjust-amount").value = "";
    $("adjust-note").value = "";
    updateAdjustPreview();
    $("adjust-dialog").showModal();
    window.setTimeout(() => $("adjust-amount").focus(), 0);
  }

  function closeAdjustDialog() {
    state.adjustingMember = null;
    $("adjust-dialog").close();
  }

  function updateAdjustPreview() {
    const preview = $("adjust-next-balance");
    const container = preview.closest(".adjust-preview");
    const rawAmount = $("adjust-amount").value;
    const amount = Number(rawAmount);

    if (!state.adjustingMember || rawAmount === "" || !Number.isFinite(amount) || amount === 0) {
      preview.textContent = "—";
      container.classList.remove("negative");
      return;
    }

    const nextBalance = Number(state.adjustingMember.balance) + amount;
    preview.textContent = `${formatMoney(nextBalance)}（${formatSignedAmount(amount)}）`;
    container.classList.toggle("negative", nextBalance < 0);
  }

  async function handleAdjustBalance(event) {
    event.preventDefault();
    const member = state.adjustingMember;
    if (!member || !state.detailReady || state.detailMutationPending) return;
    const ledgerId = member.ledger_id;

    const amount = Number($("adjust-amount").value);
    const note = $("adjust-note").value.trim();
    if (!Number.isFinite(amount) || amount === 0) {
      showToast("变动金额必须是非零数字。", "error");
      return;
    }

    const button = $("adjust-submit-button");
    setButtonBusy(button, true, "保存中…");
    setDetailMutationPending(true);
    try {
      const { error } = await state.client.rpc("adjust_balance", {
        p_member_id: member.id,
        p_amount: amount,
        p_note: note
      });
      if (error) throw error;

      if (state.currentLedger?.id === ledgerId) {
        if (state.adjustingMember?.id === member.id) closeAdjustDialog();
        const refreshed = await refreshLedgerDetail();
        if (state.currentLedger?.id === ledgerId && refreshed !== null) {
          showToast(
            refreshed ? `${member.name} 的余额已更新。` : "余额已更新，但页面刷新失败，请勿重复提交，并重新进入账本。",
            refreshed ? "success" : "error"
          );
        }
      }
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
      setDetailMutationPending(false);
    }
  }

  async function handleDeleteLedger() {
    if (!state.currentLedger || !state.detailReady || state.detailMutationPending) return;
    const ledgerId = state.currentLedger.id;
    const name = state.currentLedger.name;
    const confirmed = window.confirm(`确定删除账本「${name}」吗？\n\n这是软删除，数据库中的成员和历史记录不会被物理删除。`);
    if (!confirmed) return;

    const button = $("delete-ledger-button");
    setButtonBusy(button, true, "删除中…");
    setDetailMutationPending(true);
    try {
      const { error } = await state.client.rpc("delete_ledger", {
        p_ledger_id: ledgerId
      });
      if (error) throw error;

      if (state.currentLedger?.id === ledgerId) {
        const refreshed = await showLedgerList({ force: true });
        showToast(refreshed ? "账本已删除。" : "账本已删除，但列表刷新失败，请刷新页面。", refreshed ? "success" : "error");
      } else if (!state.currentLedger) {
        await refreshLedgerList();
      }
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
      setDetailMutationPending(false);
    }
  }

  async function handleCopySummary() {
    if (!state.currentLedger || !state.detailReady || state.detailMutationPending) return;

    const lines = ["本群账单列表汇总："];
    state.members.forEach((member) => {
      lines.push(`${member.name}账单汇总：${formatSummaryAmount(member.balance)}`);
    });
    lines.push("======");
    lines.push(`总账单汇总：${formatSummaryAmount(totalBalance())}`);

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      showToast("汇总已复制到剪贴板。", "success");
    } catch {
      window.prompt("浏览器没有允许自动复制，请选中下面的文字后手动复制：", lines.join("\n"));
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
    $("load-more-transactions-button").addEventListener("click", handleLoadMoreTransactions);
    $("adjust-form").addEventListener("submit", handleAdjustBalance);
    $("adjust-amount").addEventListener("input", updateAdjustPreview);
    $("adjust-close-button").addEventListener("click", closeAdjustDialog);
    $("adjust-cancel-button").addEventListener("click", closeAdjustDialog);
    $("adjust-dialog").addEventListener("close", () => {
      state.adjustingMember = null;
    });
  }

  async function init() {
    bindEvents();

    if (isPrivilegedKey()) {
      showOnly("setup");
      $("setup-view").querySelector(".muted").textContent =
        "检测到 Secret / service_role 高权限密钥。请立即从 config.js 删除并在 Supabase 中轮换该密钥。";
      return;
    }

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
