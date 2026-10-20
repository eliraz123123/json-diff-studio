const $ = selector => document.querySelector(selector);
const signinView = $("#signin-view");
const appView = $("#app-view");
const appMessage = $("#app-message");
const list = $("#monitor-list");
const detail = $("#monitor-detail");
const dialog = $("#monitor-dialog");
const form = $("#monitor-form");
const formMessage = $("#form-message");

let me = null;
let config = null;
let monitors = [];
let selectedId = null;
let editing = null;

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

// Builds DOM nodes without innerHTML so API data can never be interpreted as markup.
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

function timeAgo(timestamp) {
  if (!timestamp) return "never";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function intervalLabel(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${minutes / 60} h`;
  return "day";
}

function statusLabel(monitor) {
  if (monitor.pausedReason === "plan") return ["paused", "Paused · over plan limit"];
  if (monitor.paused) return ["paused", "Paused"];
  if (monitor.status === "down") return ["down", "Failing"];
  if (monitor.status === "healthy") return ["healthy", "Healthy"];
  return ["pending", "Waiting for first check"];
}

function say(target, text, tone = "error") {
  target.textContent = text;
  target.dataset.tone = tone;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const loginToken = params.get("login");
  const billing = params.get("billing");
  if (loginToken || billing) history.replaceState(null, "", "/app" + location.hash);

  config = await api("/api/plans");
  try {
    me = await api("/api/me");
  } catch (error) {
    if (error.status !== 401) throw error;
    me = null;
  }
  if (!me) return showSignin(loginToken);

  showApp();
  if (billing === "success") say(appMessage, "Thanks! Your plan updates within a few seconds of payment. Refresh if it has not changed.", "ok");
  if (billing === "cancelled") say(appMessage, "Checkout cancelled. You have not been charged.", "ok");
  await loadMonitors();
  const hashId = Number(location.hash.match(/^#monitor-(\d+)$/)?.[1]);
  if (hashId) selectMonitor(hashId);
}

function showSignin(loginToken) {
  signinView.hidden = false;
  appView.hidden = true;
  if (loginToken) {
    // Requiring a click stops email link scanners from using up the one-time link.
    $("#signin-form").hidden = true;
    $("#finish-signin").hidden = false;
    $("#finish-button").addEventListener("click", async () => {
      try {
        await api("/api/auth/verify", { method: "POST", body: { token: loginToken } });
        location.reload();
      } catch (error) {
        say($("#signin-message"), error.message);
        $("#signin-form").hidden = false;
        $("#finish-signin").hidden = true;
      }
    });
  }
}

$("#signin-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/auth/login", { method: "POST", body: { email: $("#signin-email").value } });
    say($("#signin-message"), "Check your inbox for a sign-in link. It expires in 15 minutes.", "ok");
  } catch (error) {
    say($("#signin-message"), error.message);
  } finally {
    button.disabled = false;
  }
});

function showApp() {
  signinView.hidden = true;
  appView.hidden = false;
  renderAccount();
}

function renderAccount() {
  $("#account-email").textContent = me.user.email;
  $("#account-plan").textContent = me.plan.name;
  $("#account-usage").textContent = `${me.usage.activeMonitors} of ${me.plan.monitors} active monitors · checks as often as every ${intervalLabel(me.plan.minIntervalMinutes)}`;
  const paid = me.user.plan !== "free";
  $("#upgrade-starter").hidden = paid || !me.billingEnabled;
  $("#upgrade-team").hidden = paid || !me.billingEnabled;
  $("#manage-billing").hidden = !me.user.hasBilling || !me.billingEnabled;
}

async function refreshMe() {
  me = await api("/api/me");
  renderAccount();
}

async function checkout(plan) {
  try {
    const { url } = await api("/api/billing/checkout", { method: "POST", body: { plan } });
    location.href = url;
  } catch (error) {
    say(appMessage, error.message);
  }
}

$("#upgrade-starter").addEventListener("click", () => checkout("starter"));
$("#upgrade-team").addEventListener("click", () => checkout("team"));
$("#manage-billing").addEventListener("click", async () => {
  try {
    location.href = (await api("/api/billing/portal", { method: "POST" })).url;
  } catch (error) {
    say(appMessage, error.message);
  }
});
$("#sign-out").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/app";
});

async function loadMonitors() {
  monitors = (await api("/api/monitors")).monitors;
  renderList();
}

function renderList() {
  if (monitors.length === 0) {
    list.replaceChildren(el("p", { class: "empty" }, "No monitors yet. Add a JSON endpoint you depend on, such as a partner API or your own staging API."));
    return;
  }
  list.replaceChildren(...monitors.map(monitor => {
    const [tone, label] = statusLabel(monitor);
    return el("button", {
      class: `monitor-card${monitor.id === selectedId ? " monitor-card--selected" : ""}`,
      type: "button",
      onclick: () => selectMonitor(monitor.id)
    },
      el("span", { class: "monitor-card__top" }, el("strong", {}, monitor.name), el("span", { class: `pill pill--${tone}` }, label)),
      el("code", { class: "monitor-card__url" }, monitor.url),
      el("span", { class: "subtle" }, `Every ${intervalLabel(monitor.effectiveIntervalMinutes)} · checked ${timeAgo(monitor.lastCheckedAt)} · ${monitor.learnedFields} fields learned`)
    );
  }));
}

function renderChange(change) {
  const labels = { added: "added", removed: "removed", changed: "new type" };
  return el("article", { class: `change change--${change.type}` },
    el("div", { class: "change__heading" }, el("span", { class: "badge" }, labels[change.type]), el("code", {}, change.path)),
    Object.hasOwn(change, "before") ? el("div", { class: "change__value" }, el("span", {}, "Was"), el("pre", {}, change.before)) : null,
    Object.hasOwn(change, "after") ? el("div", { class: "change__value" }, el("span", {}, "Now"), el("pre", {}, change.after)) : null
  );
}

async function selectMonitor(id) {
  selectedId = id;
  location.hash = `monitor-${id}`;
  renderList();
  let data;
  try {
    data = await api(`/api/monitors/${id}`);
  } catch (error) {
    say(appMessage, error.message);
    return;
  }
  const { monitor, events, checks, schema } = data;
  const [tone, label] = statusLabel(monitor);
  const action = (text, handler, className = "button button--secondary") => el("button", {
    class: className,
    type: "button",
    onclick: async event => {
      event.currentTarget.disabled = true;
      try {
        await handler();
      } catch (error) {
        say(appMessage, error.message);
      }
      await Promise.all([loadMonitors(), refreshMe()]);
      if (monitors.some(item => item.id === id)) selectMonitor(id);
      else detail.hidden = true;
    }
  }, text);

  const schemaEntries = Object.entries(schema);
  detail.hidden = false;
  detail.replaceChildren(...[
    el("div", { class: "results-header" },
      el("div", {},
        el("h2", {}, monitor.name, " ", el("span", { class: `pill pill--${tone}` }, label)),
        el("p", { class: "subtle" }, el("code", {}, monitor.url))
      ),
      el("div", { class: "toolbar__main" },
        action("Run check now", async () => {
          const { result } = await api(`/api/monitors/${id}/check`, { method: "POST" });
          say(appMessage, result.ok
            ? (result.changes.length ? `Check finished: ${result.changes.length} change(s) found.` : "Check finished: no schema changes.")
            : `Check failed: ${result.error}`, result.ok ? "ok" : "error");
        }, "button button--primary"),
        el("button", { class: "button button--secondary", type: "button", onclick: () => openForm(monitor) }, "Edit"),
        action(monitor.paused ? "Resume" : "Pause", () => api(`/api/monitors/${id}`, { method: "PATCH", body: { paused: !monitor.paused } })),
        action("Relearn schema", async () => {
          if (!confirm("Forget the learned schema? The next response becomes the new baseline.")) return;
          await api(`/api/monitors/${id}/reset`, { method: "POST" });
        }),
        action("Delete", async () => {
          if (!confirm(`Delete "${monitor.name}" and its history?`)) return;
          await api(`/api/monitors/${id}`, { method: "DELETE" });
          selectedId = null;
          history.replaceState(null, "", "/app");
        }, "button button--text")
      )
    ),
    monitor.lastError ? el("p", { class: "notice", "data-tone": "error" }, `Last check failed: ${monitor.lastError}`) : null,
    el("dl", { class: "facts" },
      el("div", {}, el("dt", {}, "Checks"), el("dd", {}, `Every ${intervalLabel(monitor.effectiveIntervalMinutes)}${monitor.effectiveIntervalMinutes !== monitor.intervalMinutes ? " (plan limit)" : ""}`)),
      el("div", {}, el("dt", {}, "Alerts"), el("dd", {}, [monitor.emailAlerts ? "Email" : null, monitor.alertWebhookHost].filter(Boolean).join(" + ") || "Off", monitor.notify === "breaking" ? " · breaking only" : "")),
      el("div", {}, el("dt", {}, "Headers"), el("dd", {}, monitor.headerNames.join(", ") || "None")),
      el("div", {}, el("dt", {}, "Ignored"), el("dd", {}, monitor.ignorePaths.join(", ") || "Nothing"))
    ),
    el("h3", {}, "Change history"),
    events.length
      ? el("div", { class: "results" }, events.map(event => el("section", { class: `event event--${event.kind}` },
        el("p", { class: "event__title" }, el("strong", {}, { drift: "Schema changed", down: "Endpoint failing", recovered: "Recovered", baseline: "Baseline captured" }[event.kind]), ` · ${event.summary} · ${new Date(event.created_at).toLocaleString()}`),
        event.changes.map(renderChange)
      )))
      : el("p", { class: "empty" }, "No events yet. The first successful check captures the baseline."),
    el("details", { class: "schema" },
      el("summary", {}, `Learned schema (${schemaEntries.length} paths)`),
      el("pre", {}, schemaEntries.slice(0, 1000).map(([path, types]) => `${path}: ${types.join(" | ")}`).join("\n") || "Nothing learned yet.")
    ),
    el("h3", {}, "Recent checks"),
    el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Time"), el("th", {}, "Result"), el("th", {}, "HTTP"), el("th", {}, "Duration"), el("th", {}, "Changes"))),
      el("tbody", {}, checks.map(check => el("tr", {},
        el("td", {}, new Date(check.checked_at).toLocaleString()),
        el("td", {}, check.ok ? "OK" : check.error),
        el("td", {}, check.status_code ?? "—"),
        el("td", {}, `${check.duration_ms} ms`),
        el("td", {}, String(check.change_count))
      )))
    ))
  ].filter(Boolean));
}

function parseLines(text) {
  return text.split("\n").map(line => line.trim()).filter(Boolean);
}

function parseHeaders(text) {
  const headers = {};
  for (const line of parseLines(text)) {
    const index = line.indexOf(":");
    if (index <= 0) throw new Error(`Header line "${line}" needs the form Name: value`);
    headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return headers;
}

function openForm(monitor = null) {
  editing = monitor;
  form.reset();
  say(formMessage, "");
  $("#monitor-form-title").textContent = monitor ? `Edit ${monitor.name}` : "New monitor";
  const interval = $("#field-interval");
  interval.replaceChildren(...config.intervals.map(minutes => el("option", {
    value: minutes,
    disabled: minutes < me.plan.minIntervalMinutes
  }, `${intervalLabel(minutes)}${minutes < me.plan.minIntervalMinutes ? " (upgrade)" : ""}`)));
  interval.value = String(monitor?.intervalMinutes ?? Math.max(me.plan.minIntervalMinutes, 60));
  $("#field-name").value = monitor?.name ?? "";
  $("#field-url").value = monitor?.url ?? "";
  $("#field-headers").placeholder = monitor?.headerNames.length
    ? `Saved: ${monitor.headerNames.join(", ")} (values hidden). Type here to replace them.`
    : "Authorization: Bearer sk_live_…";
  $("#keep-headers-label").hidden = !monitor?.headerNames.length;
  $("#field-ignore").value = monitor?.ignorePaths.join("\n") ?? "";
  $("#field-notify").value = monitor?.notify ?? "all";
  $("#field-email").checked = monitor?.emailAlerts ?? true;
  $("#clear-webhook-label").hidden = !monitor?.alertWebhookHost;
  $("#field-webhook").disabled = !me.plan.webhooks;
  $("#field-webhook").placeholder = !me.plan.webhooks
    ? "Slack, Discord and webhook alerts are on the Starter and Team plans"
    : monitor?.alertWebhookHost
      ? `Saved webhook on ${monitor.alertWebhookHost}. Type a new URL to replace it.`
      : "https://hooks.slack.com/services/…";
  dialog.showModal();
}

$("#new-monitor").addEventListener("click", () => openForm());
$("#form-cancel").addEventListener("click", () => dialog.close());

form.addEventListener("submit", async event => {
  event.preventDefault();
  let body;
  try {
    body = {
      name: $("#field-name").value,
      url: $("#field-url").value,
      intervalMinutes: Number($("#field-interval").value),
      ignorePaths: parseLines($("#field-ignore").value),
      notify: $("#field-notify").value,
      emailAlerts: $("#field-email").checked
    };
    const headersText = $("#field-headers").value;
    if (headersText.trim()) body.headers = parseHeaders(headersText);
    else if (!editing || $("#field-clear-headers").checked) body.headers = {};
    const webhook = $("#field-webhook").value.trim();
    if (webhook) body.alertWebhook = webhook;
    else if (editing && $("#field-clear-webhook").checked) body.alertWebhook = null;
  } catch (error) {
    say(formMessage, error.message);
    return;
  }
  try {
    const { monitor } = editing
      ? await api(`/api/monitors/${editing.id}`, { method: "PATCH", body })
      : await api("/api/monitors", { method: "POST", body });
    dialog.close();
    await Promise.all([loadMonitors(), refreshMe()]);
    selectMonitor(monitor.id);
  } catch (error) {
    say(formMessage, error.message);
  }
});

boot().catch(error => {
  signinView.hidden = false;
  say($("#signin-message"), `Could not load the app: ${error.message}`);
});
