/* No framework, remote fonts, analytics or network services: the same files work on Pages. */
const $ = (selector) => document.querySelector(selector);
const getPreference = (key, fallback = null) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const setPreference = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const system = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const theme = getPreference("theme") || (system.matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  for (const source of document.querySelectorAll("source[data-dark]"))
    source.media = theme === "dark" ? "all" : "not all";
}
applyTheme();
system.addEventListener("change", applyTheme);
window.addEventListener("storage", applyTheme);
$("#theme").onclick = () => {
  setPreference(
    "theme",
    document.documentElement.dataset.theme === "dark" ? "light" : "dark",
  );
  applyTheme();
};
$("#menu").onclick = () => {
  const open = $("#sidebar").classList.toggle("open");
  $("#menu").setAttribute("aria-expanded", String(open));
};
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("#sidebar").classList.remove("open");
    $("#menu").setAttribute("aria-expanded", "false");
  }
});
const activeLink = $(".sidebar [aria-current]");
if (activeLink)
  $("#sidebar").scrollTop = Math.max(0, activeLink.offsetTop - 220);
for (const button of document.querySelectorAll("[data-close]"))
  button.onclick = () => document.getElementById(button.dataset.close).close();
for (const pre of document.querySelectorAll("pre")) {
  const button = document.createElement("button");
  button.className = "copy-code";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy code");
  const code = pre.querySelector("code")?.textContent || pre.textContent;
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select to copy";
    }
    setTimeout(() => (button.textContent = "Copy"), 1800);
  };
  pre.append(button);
}
let index;
async function search() {
  const results = $("#search-results");
  try {
    index ??= await fetch("search.json").then((r) => {
      if (!r.ok) throw Error();
      return r.json();
    });
    const query = $("#search").value.trim().toLowerCase();
    results.replaceChildren();
    if (!query) {
      results.textContent =
        "Try “first run”, “SSH”, “verification” or “models”.";
      return;
    }
    const words = query.split(/\s+/);
    const matches = index
      .map((doc) => ({
        doc,
        score: words.reduce(
          (n, w) =>
            n +
            (doc.title.toLowerCase().includes(w) ? 15 : 0) +
            (doc.body.toLowerCase().includes(w) ? 1 : 0),
          0,
        ),
      }))
      .filter(({ doc }) =>
        words.every((w) =>
          (doc.title + " " + doc.body).toLowerCase().includes(w),
        ),
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    if (!matches.length)
      results.textContent =
        "No matching guides. Try fewer words or use the guide navigation.";
    for (const { doc } of matches) {
      const a = document.createElement("a");
      a.href = doc.id + ".html";
      a.textContent = doc.title;
      const small = document.createElement("small");
      small.textContent = doc.group;
      a.append(small);
      results.append(a);
    }
  } catch {
    results.textContent =
      "Search could not load. Use the guide navigation or try again.";
    index = undefined;
  }
}
$("#open-search").onclick = () => {
  $("#search-dialog").showModal();
  $("#search").focus();
  void search();
};
$("#search").oninput = () => void search();
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("#search-dialog").open) $("#open-search").click();
  }
});
// Only the application server enables the companion. The static build omits its controls.
const local = document.documentElement.dataset.localDocs === "true";
$("#back-app").hidden = !local;
if (local && $("#help-panel")) initializeCompanion();
function initializeCompanion() {
  const panel = $("#help-panel");
  const mobile = matchMedia("(max-width: 760px)");
  const key = "codeflow-docs-chat-v1";
  let saved = {};
  try {
    const raw = sessionStorage.getItem(key);
    if (raw && raw.length < 300000) saved = JSON.parse(raw) || {};
  } catch {}
  let history = Array.isArray(saved.history) ? saved.history.filter(h =>
    typeof h?.question === "string" && h.question.length <= 4000 &&
    typeof h.answer === "string" && h.answer.length <= 12000).slice(-3) : [];
  let messages = Array.isArray(saved.messages) ? saved.messages.filter(m =>
    ["question", "answer"].includes(m?.kind) && typeof m.text === "string" &&
    m.text.length <= 12000).slice(-12) : [];
  let stop, initialized = false, initializing = false, generation = 0;
  let opened = typeof saved.open === "boolean" ? saved.open : !mobile.matches;
  $("#question").value = typeof saved.draft === "string" ? saved.draft.slice(0, 4000) : "";
  function persist() {
    try {
      sessionStorage.setItem(key, JSON.stringify({ messages, history, draft: $("#question").value, open: opened }));
    } catch {}
  }
  function layout() {
    panel.hidden = !opened;
    document.body.classList.toggle("help-open", opened);
    $("#open-help").setAttribute("aria-expanded", String(opened));
    for (const el of [$("#content"), $("#sidebar"), $(".on-page")])
      el.inert = opened && mobile.matches;
  }
  function openHelp(focus = true) {
    opened = true;
    layout();
    persist();
    if (focus) $("#close-help").focus();
    void connect();
  }
  function closeHelp() {
    opened = false;
    layout();
    persist();
    $("#open-help").focus();
  }
  function renderMessage(message) {
    const node = document.createElement("div");
    node.className = "message " + message.kind;
    const label = document.createElement("strong");
    label.className = "message-author";
    label.textContent = message.kind === "question" ? "You" : "Code Flow";
    const body = document.createElement("div");
    body.textContent = message.text;
    node.append(label, body);
    if (Array.isArray(message.sources)) {
      const list = document.createElement("div");
      list.className = "sources";
      for (const source of message.sources.slice(0, 5)) {
        if (!/^[a-z\d-]{1,80}$/.test(source?.id) || typeof source.title !== "string") continue;
        const link = document.createElement("a");
        link.href = source.id + ".html";
        link.textContent = source.title;
        list.append(link);
      }
      node.append(list);
    }
    $("#help-messages").append(node);
  }
  function renderMessages() {
    for (const node of document.querySelectorAll("#help-messages .message")) node.remove();
    $("#chat-welcome").hidden = messages.length > 0;
    messages.forEach(renderMessage);
    $("#help-messages").scrollTop = $("#help-messages").scrollHeight;
  }
  function appendMessage(text, kind, sources = []) {
    messages = [...messages, { text, kind, sources }].slice(-12);
    renderMessages();
    persist();
  }
  async function connect() {
    if (initialized || initializing) return;
    initializing = true;
    $("#retry-help").hidden = true;
    $("#help-status").textContent = "Checking your installed CLIs…";
    try {
      const response = await fetch("/api/docs-help");
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Open the owner app and sign in to use the companion.");
      if (!data.agents.length) throw Error("No supported CLI found. Install and sign in to Claude Code, Codex or Antigravity, then retry.");
      $("#help-agent").replaceChildren();
      for (const agent of data.agents) {
        const option = document.createElement("option");
        option.value = agent.id;
        option.textContent = agent.displayName;
        $("#help-agent").append(option);
      }
      const agent = getPreference("docs-help-agent");
      if (data.agents.some(a => a.id === agent)) $("#help-agent").value = agent;
      $("#help-form").hidden = false;
      $("#help-status").textContent = "Answers use your guides. Check the linked sources for details.";
      initialized = true;
    } catch (error) {
      $("#help-status").textContent = error.message;
      $("#retry-help").hidden = false;
    } finally { initializing = false; }
  }
  $("#open-help").hidden = false;
  $("#open-help").onclick = () => opened ? closeHelp() : openHelp();
  $("#close-help").onclick = closeHelp;
  $("#retry-help").onclick = () => void connect();
  mobile.addEventListener("change", layout);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && opened && !$("#search-dialog").open) closeHelp();
  });
  $("#question").oninput = persist;
  $("#question").onkeydown = event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!stop) $("#help-form").requestSubmit();
    }
  };
  $("#help-agent").onchange = () => setPreference("docs-help-agent", $("#help-agent").value);
  for (const button of document.querySelectorAll("[data-question]"))
    button.onclick = () => { $("#question").value = button.dataset.question; persist(); $("#question").focus(); };
  $("#stop-help").onclick = () => stop?.abort();
  function resetBusy() {
    stop = undefined;
    panel.removeAttribute("aria-busy");
    $("#send-help").disabled = false;
    $("#stop-help").hidden = true;
    $("#help-agent").disabled = false;
  }
  $("#new-chat").onclick = () => {
    generation++;
    stop?.abort();
    resetBusy();
    messages = []; history = [];
    $("#question").value = "";
    renderMessages(); persist();
    $("#help-status").textContent = initialized ? "A fresh conversation. What would you like to know?" : "Connect your CLI to start chatting.";
    if (initialized) $("#question").focus();
  };
  window.addEventListener("pagehide", () => { persist(); stop?.abort(); });
  $("#help-form").onsubmit = async event => {
    event.preventDefault();
    if (stop || !initialized) return;
    const question = $("#question").value.trim();
    if (!question) return;
    const agent = $("#help-agent").value;
    setPreference("docs-help-agent", agent);
    let settings = {};
    try { settings = JSON.parse(getPreference("agentSettings", "{}"))[agent] || {}; } catch {}
    const controller = new AbortController();
    const turn = ++generation;
    stop = controller;
    panel.setAttribute("aria-busy", "true");
    $("#send-help").disabled = true;
    $("#stop-help").hidden = false;
    $("#help-agent").disabled = true;
    $("#question").value = "";
    appendMessage(question, "question");
    $("#help-status").textContent = "Reading the guides with your CLI…";
    try {
      const response = await fetch("/api/docs-help", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, agent, page: document.body.dataset.page, history,
          settings: { model: settings.model, effort: settings.effort } }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (turn !== generation) return;
      if (!response.ok) throw Error(data.error || "The CLI could not answer. Try again.");
      history = [...history, { question, answer: data.answer }].slice(-3);
      appendMessage(data.answer, "answer", data.sources);
      $("#help-status").textContent = "Continue with a follow-up or explore a source guide.";
    } catch (error) {
      if (turn !== generation) return;
      $("#help-status").textContent = controller.signal.aborted ? "Stopped. You can ask again." : error.message;
      $("#question").value ||= question;
      persist();
    } finally {
      if (turn === generation) resetBusy();
    }
  };
  renderMessages();
  layout();
  if (opened) openHelp(false);
}
