(() => {
  "use strict";

  const config = window.TENNIS_LEDGER_CONFIG ?? {};
  const SUPABASE_PLACEHOLDER = "YOUR_PROJECT";
  const KEY_PLACEHOLDER = "YOUR_PUBLISHABLE_KEY";
  const TRANSACTION_PAGE_SIZE = 100;

  const state = {
    client: null,
    session: null,
    isAdmin: false,
    shareToken: null,
    currentLedger: null,
    members: [],
    transactions: [],
    transactionsHasMore: false,
    detailRequestId: 0,
    detailReady: false,
    detailMutationPending: false,
    passwordMutationPending: false,
    pendingMember: null,
    deletingMember: null,
    ledgerListRequestId: 0,
    adjustingMember: null,
    toastTimer: null
  };

  const $ = (id) => document.getElementById(id);

  const views = {
    setup: $("setup-view"),
    login: $("login-view"),
    shareError: $("share-error-view"),
    app: $("app-view"),
    ledgerList: $("ledger-list-view"),
    ledgerDetail: $("ledger-detail-view")
  };

  function showOnly(viewName) {
    [views.setup, views.login, views.shareError, views.app]
      .filter(Boolean)
      .forEach((el) => el.classList.add("hidden"));
    if (!views[viewName]) throw new Error("页面文件版本不一致，请重新部署全部网页文件。");
    views[viewName].classList.remove("hidden");
  }

  function setOptionalText(id, text) {
    const element = $(id);
    if (element) element.textContent = text;
  }

  function setOptionalHidden(id, hidden) {
    const element = $(id);
    if (element) element.classList.toggle("hidden", hidden);
  }

  function getShareTokenFromUrl() {
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.slice(1));
    const value = hashParams.get("ledger") ?? url.searchParams.get("ledger");
    if (value === null) return null;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value
      : "";
  }

  function clearShareTokenFromUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("ledger");
    const hashParams = new URLSearchParams(url.hash.slice(1));
    hashParams.delete("ledger");
    url.hash = hashParams.toString();
    window.history.replaceState(null, "", url);
  }

  function buildShareUrl(ledger) {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = new URLSearchParams({ ledger: ledger.share_token }).toString();
    return url.toString();
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
    const controls = [$("copy-summary-button"), $("load-more-transactions-button")];
    if (state.isAdmin) {
      controls.push(
        $("delete-ledger-button"),
        $("copy-share-link-button"),
        $("add-member-form").querySelector("button[type='submit']")
      );
    }
    controls.forEach((button) => {
      if (button) button.disabled = disabled || button.dataset.busy === "true";
    });
    const deleteMemberButton = $("delete-member-button");
    if (state.isAdmin && deleteMemberButton) {
      deleteMemberButton.disabled =
        disabled || state.members.length === 0 || deleteMemberButton.dataset.busy === "true";
    }
    $("member-list").querySelectorAll("button").forEach((button) => {
      button.disabled = disabled || button.dataset.busy === "true";
    });
  }

  function setDetailMutationPending(pending) {
    state.detailMutationPending = pending;
    $("back-button").disabled = pending;
    $("logout-button").disabled = pending || state.passwordMutationPending;
    $("change-password-button").disabled = pending || state.passwordMutationPending;
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
    if (message.includes("Initial balance cannot be negative")) return "初始余额不能小于 0。";
    if (message.includes("Balance cannot be negative")) return "余额不能小于 0，扣减金额不能超过当前余额。";
    if (message.includes("Member name confirmation does not match")) return "输入的用户姓名不匹配。";
    if (message.includes("Member does not exist")) return "用户不存在或已经被删除。";
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
    state.shareToken = null;
    state.isAdmin = await ensureAdmin();
    if (!state.isAdmin) {
      await state.client.auth.signOut();
      state.session = null;
      showOnly("login");
      setLoginError("这个账号没有管理员权限。普通查看者请直接打开管理员发来的只读链接。");
      return;
    }

    document.querySelectorAll(".admin-only").forEach((element) => {
      element.classList.remove("hidden");
    });
    setOptionalText("account-role", "管理员");
    $("account-role")?.classList.remove("readonly");
    setOptionalText("account-email", state.session.user.email || "已登录账号");
    setOptionalText("admin-email", state.session.user.email || "已登录账号");
    setOptionalHidden("account-email", false);
    setOptionalHidden("logout-button", false);
    setOptionalText("ledger-list-title", "账本");
    setOptionalText("ledger-list-description", "创建不同账本，分别管理成员余额。");
    setOptionalText("ledger-empty-description", "在上方输入名称并创建第一个账本。");
    setLoginError();
    showOnly("app");
    await showLedgerList();
  }

  async function enterSharedLedger(shareToken) {
    if (!shareToken) {
      showOnly("shareError");
      return;
    }

    const { data, error } = await state.client.rpc("get_shared_ledger", {
      p_share_token: shareToken
    });
    const ledger = data;
    if (error || !ledger) {
      showOnly("shareError");
      return;
    }

    state.isAdmin = false;
    state.shareToken = shareToken;
    state.currentLedger = {
      id: ledger.id,
      name: ledger.name,
      created_at: ledger.created_at
    };
    state.members = ledger.members || [];
    state.transactions = ledger.transactions || [];
    state.transactionsHasMore = false;
    document.querySelectorAll(".admin-only").forEach((element) => {
      element.classList.add("hidden");
    });
    setOptionalText("account-role", "只读分享");
    $("account-role")?.classList.add("readonly");
    setOptionalHidden("account-email", true);
    setOptionalHidden("logout-button", true);
    $("page-title").textContent = ledger.name;
    $("ledger-title").textContent = ledger.name;
    $("back-button").classList.add("hidden");
    views.ledgerList.classList.add("hidden");
    views.ledgerDetail.classList.remove("hidden");
    showOnly("app");
    setDetailStatus("", "ready");
    renderMembers();
    renderTransactions();
  }

  async function showAdminLogin() {
    clearShareTokenFromUrl();
    state.shareToken = null;
    const { data, error } = await state.client.auth.getSession();
    if (error) {
      showOnly("login");
      setLoginError(normalizeError(error));
      return;
    }

    state.session = data.session;
    if (!state.session) {
      setLoginError();
      showOnly("login");
      return;
    }

    try {
      await enterApp();
    } catch (enterError) {
      showOnly("login");
      setLoginError(normalizeError(enterError));
    }
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
      clearShareTokenFromUrl();
      await enterApp();
      $("password").value = "";
    } catch (error) {
      setLoginError(normalizeError(error));
    } finally {
      setButtonBusy(button, false);
    }
  }

  function setPasswordError(message = "") {
    const error = $("password-error");
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  }

  function setPasswordMutationPending(pending) {
    state.passwordMutationPending = pending;
    $("change-password-button").disabled = pending || state.detailMutationPending;
    $("logout-button").disabled = pending || state.detailMutationPending;
    $("password-close-button").disabled = pending;
    $("password-cancel-button").disabled = pending;
    $("current-password").disabled = pending;
    $("new-password").disabled = pending;
    $("confirm-password").disabled = pending;
  }

  function openPasswordDialog() {
    if (!state.isAdmin || state.passwordMutationPending || state.detailMutationPending) return;
    $("password-form").reset();
    setPasswordError();
    $("password-dialog").showModal();
    window.setTimeout(() => $("current-password").focus(), 0);
  }

  function closePasswordDialog() {
    if (state.passwordMutationPending) return;
    $("password-form").reset();
    setPasswordError();
    $("password-dialog").close();
  }

  async function handlePasswordChange(event) {
    event.preventDefault();
    if (!state.isAdmin || state.passwordMutationPending || state.detailMutationPending) return;

    const email = state.session?.user?.email;
    const currentPassword = $("current-password").value;
    const newPassword = $("new-password").value;
    const confirmPassword = $("confirm-password").value;
    setPasswordError();

    if (!email || !currentPassword) {
      setPasswordError("请输入当前密码。");
      return;
    }
    if (newPassword.length < 12) {
      setPasswordError("新密码至少需要 12 位。");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("两次输入的新密码不一致。");
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordError("新密码不能与当前密码相同。");
      return;
    }

    const button = $("password-submit-button");
    setButtonBusy(button, true, "修改中…");
    setPasswordMutationPending(true);
    try {
      const { data: loginData, error: loginError } = await state.client.auth.signInWithPassword({
        email,
        password: currentPassword
      });
      if (loginError) {
        if (loginError.message?.includes("Invalid login credentials")) {
          setPasswordError("当前密码不正确。");
          return;
        }
        throw loginError;
      }

      state.session = loginData.session;
      const { error: updateError } = await state.client.auth.updateUser({
        password: newPassword
      });
      if (updateError) throw updateError;

      $("password-form").reset();
      $("password-dialog").close();
      showToast("密码已修改。下次登录请使用新密码。", "success");
    } catch (error) {
      setPasswordError(normalizeError(error));
    } finally {
      setButtonBusy(button, false);
      setPasswordMutationPending(false);
    }
  }

  async function handleLogout() {
    await state.client.auth.signOut();
    state.session = null;
    state.isAdmin = false;
    state.shareToken = null;
    state.currentLedger = null;
    state.members = [];
    state.transactions = [];
    state.transactionsHasMore = false;
    state.detailRequestId += 1;
    state.detailReady = false;
    state.detailMutationPending = false;
    state.passwordMutationPending = false;
    state.pendingMember = null;
    state.deletingMember = null;
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
      const shareButton = createTextElement("button", "ghost", "复制只读链接");
      shareButton.type = "button";
      shareButton.addEventListener("click", () => copyShareLink(ledger));

      const actions = document.createElement("div");
      actions.className = "ledger-card-actions";
      actions.append(openButton, shareButton);

      const textGroup = document.createElement("div");
      textGroup.append(title, meta);
      card.append(textGroup, actions);
      list.append(card);
    });
  }

  async function fetchLedgers() {
    const { data, error } = await state.client
      .from("ledgers")
      .select("id,name,share_token,created_at")
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
    if (!state.isAdmin) return;
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
    state.deletingMember = null;
    setDetailStatus("正在加载账本数据…");
    $("member-name").value = "";
    $("member-balance").value = "0";
    $("page-title").textContent = ledger.name;
    $("ledger-title").textContent = ledger.name;
    $("back-button").classList.toggle("hidden", Boolean(state.shareToken));
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

      row.append(nameWrap, balance);
      if (state.isAdmin) {
        const adjustButton = createTextElement("button", "ghost", "调整余额");
        adjustButton.type = "button";
        adjustButton.disabled = !state.detailReady || state.detailMutationPending;
        adjustButton.addEventListener("click", () => openAdjustDialog(member));
        row.append(adjustButton);
      } else {
        row.classList.add("readonly");
      }
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

  function setAddMemberConfirmError(message = "") {
    const error = $("add-member-confirm-error");
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  }

  function openAddMemberConfirmation(event) {
    event.preventDefault();
    if (!state.isAdmin || !state.currentLedger || !state.detailReady || state.detailMutationPending) return;

    const name = $("member-name").value.trim();
    const initialBalance = Number($("member-balance").value);
    if (!name || !Number.isFinite(initialBalance)) return;
    if (initialBalance < 0) {
      showToast("初始余额不能小于 0。", "error");
      return;
    }

    state.pendingMember = {
      ledgerId: state.currentLedger.id,
      name,
      initialBalance
    };
    $("confirm-member-name").textContent = name;
    $("confirm-member-balance").textContent = formatMoney(initialBalance);
    $("confirm-member-balance").classList.toggle("negative", initialBalance < 0);
    setAddMemberConfirmError();
    $("add-member-dialog").showModal();
  }

  function closeAddMemberConfirmation() {
    if (state.detailMutationPending) return;
    state.pendingMember = null;
    setAddMemberConfirmError();
    $("add-member-dialog").close();
  }

  async function handleAddMember(event) {
    event.preventDefault();
    const pendingMember = state.pendingMember;
    if (
      !state.isAdmin ||
      !pendingMember ||
      !state.currentLedger ||
      pendingMember.ledgerId !== state.currentLedger.id ||
      !state.detailReady ||
      state.detailMutationPending
    ) return;

    const { ledgerId, name, initialBalance } = pendingMember;
    const button = $("add-member-confirm-submit-button");

    setButtonBusy(button, true, "添加中…");
    setDetailMutationPending(true);
    $("add-member-confirm-close-button").disabled = true;
    $("add-member-confirm-cancel-button").disabled = true;
    setAddMemberConfirmError();
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
        state.pendingMember = null;
        $("add-member-dialog").close();
        const refreshed = await refreshLedgerDetail();
        if (state.currentLedger?.id === ledgerId && refreshed !== null) {
          showToast(refreshed ? "用户已添加。" : "用户已添加，但页面刷新失败，请勿重复提交，并重新进入账本。", refreshed ? "success" : "error");
        }
      }
    } catch (error) {
      setAddMemberConfirmError(normalizeError(error));
    } finally {
      setButtonBusy(button, false);
      $("add-member-confirm-close-button").disabled = false;
      $("add-member-confirm-cancel-button").disabled = false;
      setDetailMutationPending(false);
    }
  }

  function openAdjustDialog(member) {
    if (!state.isAdmin || !state.detailReady || state.detailMutationPending || member.ledger_id !== state.currentLedger?.id) return;
    state.adjustingMember = member;
    $("adjust-member-name").textContent = member.name;
    $("adjust-current-balance").textContent = formatMoney(member.balance);
    $("adjust-direction").value = "subtract";
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
    const amountInput = $("adjust-amount");
    const submitButton = $("adjust-submit-button");
    const rawAmount = amountInput.value;
    const magnitude = Number(rawAmount);
    const isAddition = $("adjust-direction").value === "add";
    const amount = isAddition ? magnitude : -magnitude;

    if (isAddition || !state.adjustingMember) {
      amountInput.removeAttribute("max");
    } else {
      amountInput.max = String(Math.max(Number(state.adjustingMember.balance), 0));
    }

    if (!state.adjustingMember || rawAmount === "" || !Number.isFinite(magnitude) || magnitude <= 0) {
      preview.textContent = "—";
      container.classList.remove("negative");
      submitButton.disabled = true;
      return;
    }

    const nextBalance = Number(state.adjustingMember.balance) + amount;
    if (nextBalance < 0) {
      preview.textContent = "无法保存：余额不能低于 ¥0.00";
      container.classList.add("negative");
      submitButton.disabled = true;
      return;
    }

    preview.textContent = `${formatMoney(nextBalance)}（${formatSignedAmount(amount)}）`;
    container.classList.remove("negative");
    submitButton.disabled = state.detailMutationPending || submitButton.dataset.busy === "true";
  }

  async function handleAdjustBalance(event) {
    event.preventDefault();
    const member = state.adjustingMember;
    if (!state.isAdmin || !member || !state.detailReady || state.detailMutationPending) return;
    const ledgerId = member.ledger_id;

    const magnitude = Number($("adjust-amount").value);
    const amount = $("adjust-direction").value === "add" ? magnitude : -magnitude;
    const note = $("adjust-note").value.trim();
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      showToast("金额必须是大于 0 的数字。", "error");
      return;
    }
    if (Number(member.balance) + amount < 0) {
      showToast("余额不能小于 0，扣减金额不能超过当前余额。", "error");
      updateAdjustPreview();
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
      if ($("adjust-dialog").open) updateAdjustPreview();
    }
  }

  function setDeleteMemberError(message = "") {
    const error = $("delete-member-error");
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  }

  function getSelectedDeleteMember() {
    const memberId = $("delete-member-select").value;
    return state.members.find((member) => String(member.id) === memberId) || null;
  }

  function updateDeleteMemberConfirmation() {
    const member = getSelectedDeleteMember();
    const confirmInput = $("delete-member-confirm-name");
    state.deletingMember = member;
    $("delete-member-name").textContent = member?.name || "—";
    $("delete-member-balance").textContent = member ? formatMoney(member.balance) : "—";
    $("delete-member-balance").classList.toggle("negative", Number(member?.balance) < 0);
    confirmInput.disabled = !member || state.detailMutationPending;
    confirmInput.placeholder = member?.name || "请先选择用户";
    $("delete-member-submit-button").disabled =
      !member || confirmInput.value !== member.name || state.detailMutationPending;
  }

  function handleDeleteMemberSelection() {
    $("delete-member-confirm-name").value = "";
    setDeleteMemberError();
    updateDeleteMemberConfirmation();
    if (state.deletingMember) window.setTimeout(() => $("delete-member-confirm-name").focus(), 0);
  }

  function openDeleteMemberDialog() {
    if (!state.isAdmin || !state.currentLedger || !state.detailReady || state.detailMutationPending) return;
    if (state.members.length === 0) {
      showToast("当前账本没有可删除的用户。", "error");
      return;
    }

    const select = $("delete-member-select");
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "请选择用户";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.append(placeholder);
    state.members.forEach((member) => {
      const option = document.createElement("option");
      option.value = String(member.id);
      option.textContent = `${member.name}（${formatMoney(member.balance)}）`;
      select.append(option);
    });

    state.deletingMember = null;
    $("delete-member-confirm-name").value = "";
    setDeleteMemberError();
    updateDeleteMemberConfirmation();
    $("delete-member-dialog").showModal();
    window.setTimeout(() => select.focus(), 0);
  }

  function closeDeleteMemberDialog() {
    if (state.detailMutationPending) return;
    state.deletingMember = null;
    $("delete-member-form").reset();
    setDeleteMemberError();
    $("delete-member-dialog").close();
  }

  async function handleDeleteMember(event) {
    event.preventDefault();
    const member = getSelectedDeleteMember();
    if (!state.isAdmin || !member || !state.currentLedger || !state.detailReady || state.detailMutationPending) return;
    const ledgerId = state.currentLedger.id;
    const confirmName = $("delete-member-confirm-name").value;
    if (member.ledger_id !== ledgerId || confirmName !== member.name) {
      setDeleteMemberError("请输入完整且完全一致的用户姓名。");
      updateDeleteMemberConfirmation();
      return;
    }

    const button = $("delete-member-submit-button");
    setButtonBusy(button, true, "删除中…");
    setDetailMutationPending(true);
    $("delete-member-select").disabled = true;
    $("delete-member-confirm-name").disabled = true;
    $("delete-member-close-button").disabled = true;
    $("delete-member-cancel-button").disabled = true;
    setDeleteMemberError();
    try {
      const { error } = await state.client.rpc("delete_member", {
        p_member_id: member.id,
        p_confirm_name: confirmName
      });
      if (error) throw error;

      if (state.currentLedger?.id === ledgerId) {
        state.deletingMember = null;
        $("delete-member-dialog").close();
        const refreshed = await refreshLedgerDetail();
        if (state.currentLedger?.id === ledgerId && refreshed !== null) {
          showToast(
            refreshed
              ? `${member.name} 已删除，历史操作记录仍保留。`
              : "用户已删除，但页面刷新失败，请勿重复提交，并重新进入账本。",
            refreshed ? "success" : "error"
          );
        }
      }
    } catch (error) {
      setDeleteMemberError(normalizeError(error));
    } finally {
      setButtonBusy(button, false);
      $("delete-member-select").disabled = false;
      $("delete-member-close-button").disabled = false;
      $("delete-member-cancel-button").disabled = false;
      setDetailMutationPending(false);
      if ($("delete-member-dialog").open) updateDeleteMemberConfirmation();
    }
  }

  function updateDeleteConfirmation() {
    const matches = Boolean(
      state.currentLedger && $("delete-confirm-name").value === state.currentLedger.name
    );
    $("delete-submit-button").disabled = !matches || state.detailMutationPending;
  }

  function openDeleteDialog() {
    if (!state.isAdmin || !state.currentLedger || !state.detailReady || state.detailMutationPending) return;
    $("delete-ledger-name").textContent = state.currentLedger.name;
    $("delete-confirm-name").value = "";
    $("delete-confirm-name").placeholder = state.currentLedger.name;
    updateDeleteConfirmation();
    $("delete-dialog").showModal();
    window.setTimeout(() => $("delete-confirm-name").focus(), 0);
  }

  function closeDeleteDialog() {
    if (state.detailMutationPending) return;
    $("delete-dialog").close();
  }

  async function handleDeleteLedger(event) {
    event.preventDefault();
    if (!state.isAdmin || !state.currentLedger || !state.detailReady || state.detailMutationPending) return;
    const ledgerId = state.currentLedger.id;
    const name = state.currentLedger.name;
    if ($("delete-confirm-name").value !== name) {
      showToast("请输入完整且完全一致的账本名称。", "error");
      updateDeleteConfirmation();
      return;
    }

    const button = $("delete-submit-button");
    setButtonBusy(button, true, "删除中…");
    setDetailMutationPending(true);
    $("delete-close-button").disabled = true;
    $("delete-cancel-button").disabled = true;
    try {
      const { error } = await state.client.rpc("delete_ledger", {
        p_ledger_id: ledgerId
      });
      if (error) throw error;

      if (state.currentLedger?.id === ledgerId) {
        $("delete-dialog").close();
        const refreshed = await showLedgerList({ force: true });
        showToast(refreshed ? "账本已删除。" : "账本已删除，但列表刷新失败，请刷新页面。", refreshed ? "success" : "error");
      } else if (!state.currentLedger) {
        await refreshLedgerList();
      }
    } catch (error) {
      showToast(normalizeError(error), "error");
    } finally {
      setButtonBusy(button, false);
      $("delete-close-button").disabled = false;
      $("delete-cancel-button").disabled = false;
      setDetailMutationPending(false);
      updateDeleteConfirmation();
    }
  }

  async function copyShareLink(ledger, successMessage = "只读链接已复制。") {
    if (!state.isAdmin || !ledger?.share_token) return;
    const shareUrl = buildShareUrl(ledger);
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast(successMessage, "success");
    } catch {
      window.prompt("浏览器没有允许自动复制，请手动复制这个只读链接：", shareUrl);
    }
  }

  function handleCopyShareLink() {
    if (state.currentLedger) copyShareLink(state.currentLedger);
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
    $("change-password-button").addEventListener("click", openPasswordDialog);
    $("password-form").addEventListener("submit", handlePasswordChange);
    $("password-close-button").addEventListener("click", closePasswordDialog);
    $("password-cancel-button").addEventListener("click", closePasswordDialog);
    $("password-dialog").addEventListener("cancel", (event) => {
      if (state.passwordMutationPending) event.preventDefault();
    });
    $("password-dialog").addEventListener("close", () => {
      if (!state.passwordMutationPending) {
        $("password-form").reset();
        setPasswordError();
      }
    });
    $("create-ledger-form").addEventListener("submit", handleCreateLedger);
    $("back-button").addEventListener("click", showLedgerList);
    $("add-member-form").addEventListener("submit", openAddMemberConfirmation);
    $("add-member-confirm-form").addEventListener("submit", handleAddMember);
    $("add-member-confirm-close-button").addEventListener("click", closeAddMemberConfirmation);
    $("add-member-confirm-cancel-button").addEventListener("click", closeAddMemberConfirmation);
    $("add-member-dialog").addEventListener("cancel", (event) => {
      if (state.detailMutationPending) {
        event.preventDefault();
      } else {
        state.pendingMember = null;
      }
    });
    $("add-member-dialog").addEventListener("close", () => {
      if (!state.detailMutationPending) {
        state.pendingMember = null;
        setAddMemberConfirmError();
      }
    });
    $("delete-ledger-button").addEventListener("click", openDeleteDialog);
    $("delete-member-button").addEventListener("click", openDeleteMemberDialog);
    $("delete-member-form").addEventListener("submit", handleDeleteMember);
    $("delete-member-select").addEventListener("change", handleDeleteMemberSelection);
    $("delete-member-confirm-name").addEventListener("input", () => {
      setDeleteMemberError();
      updateDeleteMemberConfirmation();
    });
    $("delete-member-close-button").addEventListener("click", closeDeleteMemberDialog);
    $("delete-member-cancel-button").addEventListener("click", closeDeleteMemberDialog);
    $("delete-member-dialog").addEventListener("cancel", (event) => {
      if (state.detailMutationPending) event.preventDefault();
    });
    $("delete-member-dialog").addEventListener("close", () => {
      if (!state.detailMutationPending) {
        state.deletingMember = null;
        $("delete-member-form").reset();
        setDeleteMemberError();
      }
    });
    $("copy-summary-button").addEventListener("click", handleCopySummary);
    $("copy-share-link-button")?.addEventListener("click", handleCopyShareLink);
    $("load-more-transactions-button").addEventListener("click", handleLoadMoreTransactions);
    $("adjust-form").addEventListener("submit", handleAdjustBalance);
    $("adjust-direction").addEventListener("change", updateAdjustPreview);
    $("adjust-amount").addEventListener("input", updateAdjustPreview);
    $("adjust-close-button").addEventListener("click", closeAdjustDialog);
    $("adjust-cancel-button").addEventListener("click", closeAdjustDialog);
    $("adjust-dialog").addEventListener("close", () => {
      state.adjustingMember = null;
    });
    $("delete-form")?.addEventListener("submit", handleDeleteLedger);
    $("delete-confirm-name")?.addEventListener("input", updateDeleteConfirmation);
    $("delete-close-button")?.addEventListener("click", closeDeleteDialog);
    $("delete-cancel-button")?.addEventListener("click", closeDeleteDialog);
    $("delete-dialog")?.addEventListener("cancel", (event) => {
      if (state.detailMutationPending) event.preventDefault();
    });
    $("share-error-admin-button")?.addEventListener("click", showAdminLogin);
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

    const shareToken = getShareTokenFromUrl();
    if (shareToken !== null) {
      try {
        await enterSharedLedger(shareToken);
      } catch {
        showOnly("shareError");
      }
      return;
    }

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
