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
        "No matching guides. Try fewer words or ask code-flow in the local app.";
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
// The local server injects this marker only into its own docs. Static Pages never probes localhost.
const local = document.documentElement.dataset.localDocs === "true";
$("#back-app").hidden = !local;
let initialized = false,
  stop,
  history = [];
async function openHelp() {
  $("#help-dialog").showModal();
  if (initialized) return;
  if (!local) {
    $("#help-status").textContent =
      "The assistant runs in your local code-flow app using your signed-in CLI. Open the app, then choose Help & documentation → Ask code-flow. These hosted guides and search work without an agent.";
    return;
  }
  $("#help-status").textContent = "Checking your installed CLIs…";
  try {
    const response = await fetch("/api/docs-help");
    const data = await response.json();
    if (!response.ok)
      throw Error(
        data.error || "Open the owner app and sign in to use the assistant.",
      );
    if (!data.agents.length)
      throw Error(
        "No supported CLI found. Install and sign in to Claude Code, Codex or Antigravity, then reopen help.",
      );
    $("#help-agent").replaceChildren();
    for (const agent of data.agents) {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.displayName;
      $("#help-agent").append(option);
    }
    const saved = getPreference("docs-help-agent");
    if (data.agents.some((a) => a.id === saved)) $("#help-agent").value = saved;
    $("#help-form").hidden = false;
    $("#help-status").textContent =
      "Ask about workflows, setup or troubleshooting. Answers use the bundled guides; verify important steps in the linked sources.";
    initialized = true;
  } catch (error) {
    $("#help-status").textContent = error.message;
  }
}
$("#open-help").onclick = () => void openHelp();
for (const button of document.querySelectorAll("[data-help]"))
  button.onclick = () => void openHelp();
for (const button of document.querySelectorAll("[data-question]"))
  button.onclick = () => {
    $("#question").value = button.dataset.question;
    $("#question").focus();
  };
function appendMessage(text, kind, sources = []) {
  const node = document.createElement("div");
  node.className = "message " + kind;
  node.textContent = text;
  if (sources.length) {
    const list = document.createElement("div");
    list.className = "sources";
    for (const source of sources) {
      const link = document.createElement("a");
      link.href = source.id + ".html";
      link.textContent = source.title;
      list.append(link);
    }
    node.append(list);
  }
  $("#help-messages").append(node);
  node.scrollIntoView({ block: "nearest" });
}
$("#stop-help").onclick = () => stop?.abort();
$("#help-dialog").addEventListener("close", () => stop?.abort());
$("#help-form").onsubmit = async (event) => {
  event.preventDefault();
  if (stop) return;
  const question = $("#question").value.trim();
  if (!question) return;
  const agent = $("#help-agent").value;
  setPreference("docs-help-agent", agent);
  let settings = {};
  try {
    settings = JSON.parse(getPreference("agentSettings", "{}"))[agent] || {};
  } catch {}
  const controller = new AbortController();
  stop = controller;
  $("#send-help").disabled = true;
  $("#stop-help").hidden = false;
  $("#help-agent").disabled = true;
  appendMessage(question, "question");
  $("#question").value = "";
  $("#help-status").textContent = "Reading the guides with your CLI…";
  try {
    const response = await fetch("/api/docs-help", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        agent,
        page: document.body.dataset.page,
        history,
        settings: { model: settings.model, effort: settings.effort },
      }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok)
      throw Error(data.error || "The CLI could not answer. Try again.");
    appendMessage(data.answer, "answer", data.sources);
    history = [...history, { question, answer: data.answer }].slice(-3);
    $("#help-status").textContent =
      "Answer complete. Continue with a follow-up or open a source guide.";
  } catch (error) {
    $("#help-status").textContent = controller.signal.aborted
      ? "Stopped. You can ask again."
      : error.message;
    $("#question").value ||= question;
  } finally {
    stop = undefined;
    $("#send-help").disabled = false;
    $("#stop-help").hidden = true;
    $("#help-agent").disabled = false;
  }
};
