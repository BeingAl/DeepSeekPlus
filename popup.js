const $ = (id) => document.getElementById(id);

const state = { prompts: [], theme: {} };
// Full storage object: patch writes must preserve keys managed by the
// content script (titles, ...).
const projectsState = { enabled: false, folders: [], assignments: {} };

const NEUTRAL = "#98a1b0"; // placeholder swatch while a color is unset
const PICKER_IDS = ["chatColor"];
const SIZE_IDS = ["chatSize"];

// Same defaults as content.js applies on the page.
const FONT_DEFAULTS = {
  chatFont: "Roboto",
  chatSize: 16,
};

const ICONS = {
  trash: `
    <svg width="14" height="14" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="m6 7 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>`,
  chat: `
    <svg width="22" height="22" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>`,
};

/* ---------- Tabs ---------- */

function switchTab(name) {
  for (const btn of document.querySelectorAll(".tab"))
    btn.classList.toggle("active", btn.dataset.tab === name);
  $("tab-prompts").hidden = name !== "prompts";
  $("tab-appearance").hidden = name !== "appearance";
  $("tab-projects").hidden = name !== "projects";
  chrome.storage.local.set({ uiTab: name });
}

for (const btn of document.querySelectorAll(".tab"))
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));

/* ---------- Prompts ---------- */

function persistPrompts() {
  chrome.storage.local.set({ prompts: state.prompts });
}

function render() {
  const list = $("list");
  list.textContent = "";
  $("count").textContent = String(state.prompts.length);

  if (!state.prompts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = ICONS.chat;
    const p = document.createElement("p");
    p.textContent = "No prompts yet. Add your first one below.";
    p.style.margin = "0";
    empty.append(p);
    list.append(empty);
    return;
  }

  state.prompts.forEach((prompt, i) => list.append(createItem(prompt, i)));
}

function createItem(prompt, i) {
  const row = document.createElement("div");
  row.className = "prompt" + (prompt.active === false ? " off" : "");

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = prompt.active !== false;
  toggle.title = toggle.checked ? "Deactivate" : "Activate";
  toggle.addEventListener("change", () => {
    state.prompts[i].active = toggle.checked;
    row.classList.toggle("off", !toggle.checked);
    persistPrompts();
  });

  const text = document.createElement("textarea");
  text.value = prompt.text;
  text.rows = 1;
  text.spellcheck = false;
  text.addEventListener("change", () => {
    state.prompts[i].text = text.value;
    persistPrompts();
  });

  const del = document.createElement("button");
  del.className = "icon-btn";
  del.title = "Delete";
  del.innerHTML = ICONS.trash;
  del.addEventListener("click", () => {
    state.prompts.splice(i, 1);
    persistPrompts();
  });

  row.append(toggle, text, del);
  return row;
}

/* ---------- Theme (fonts, sizes, colors) ---------- */

let saveTimer = null;

// Debounced so live color-drag / size typing produces one write per pause;
// the content script re-applies the theme on every storage change.
function saveTheme(patch) {
  state.theme = { ...state.theme, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(
    () => chrome.storage.local.set({ theme: state.theme }),
    80,
  );
}

function syncThemeInputs() {
  const t = { ...FONT_DEFAULTS, ...state.theme };
  $("chatFont").value = t.chatFont || "";
  for (const id of SIZE_IDS) $(id).value = t[id] ?? "";
  for (const id of PICKER_IDS) {
    const input = $(id);
    input.value = t[id] || NEUTRAL;
    input.closest(".pick-wrap").classList.toggle("unset", !t[id]);
  }
}

// Downloads a Google Font by name, caches it in local storage and activates
// it for the given theme key. An empty name resets to the site default.
async function applyFont(inputId, statusId, themeKey) {
  const status = $(statusId);
  const name = $(inputId).value.trim().replace(/["']/g, "");

  status.className = "status";
  if (!name) {
    saveTheme({ [themeKey]: "" });
    status.textContent = "Reverted to the default font";
    return;
  }

  status.textContent = "Downloading from Google Fonts...";
  try {
    const css = await DSFonts.fetchEmbeddedCss(name);
    if (!css) {
      status.className = "status warn";
      status.textContent = "Font not found on Google Fonts";
      return;
    }
    await chrome.storage.local.set({ [DSFonts.storageKey(name)]: css });
    saveTheme({ [themeKey]: name });
    status.className = "status ok";
    status.textContent = "Font loaded: " + name;
  } catch {
    status.className = "status warn";
    status.textContent = "Download failed, check your connection";
  }
}

/* ---------- Font search (bundled Google Fonts catalog) ---------- */

let fontCatalog = null; // [[family, category], ...] in popularity order

async function loadFontCatalog() {
  if (fontCatalog) return fontCatalog;
  try {
    fontCatalog = await (
      await fetch(chrome.runtime.getURL("fonts.json"))
    ).json();
  } catch {
    fontCatalog = [];
  }
  return fontCatalog;
}

function matchFonts(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = [];
  const contains = [];
  for (const entry of fontCatalog) {
    const name = entry[0].toLowerCase();
    if (name.startsWith(q)) starts.push(entry);
    else if (name.includes(q)) contains.push(entry);
  }
  return [...starts, ...contains].slice(0, 8);
}

// Attaches realtime autocomplete to a font field. Picking a suggestion (or
// pressing Enter) downloads the font and applies it immediately.
function wireFontField(inputId, menuId, statusId, themeKey) {
  const input = $(inputId);
  const menu = $(menuId);
  let highlighted = -1;

  const closeMenu = () => {
    menu.hidden = true;
    menu.textContent = "";
    highlighted = -1;
  };

  const renderMenu = () => {
    const matches = matchFonts(input.value);
    if (!matches.length || input.value.trim() === state.theme[themeKey]) {
      closeMenu();
      return;
    }
    menu.textContent = "";
    matches.forEach(([name, category], i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "font-item";
      item.dataset.name = name;
      const label = document.createElement("span");
      label.textContent = name;
      const cat = document.createElement("span");
      cat.className = "cat";
      cat.textContent = category;
      item.append(label, cat);
      // mousedown beats the input's blur event
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = name;
        closeMenu();
        applyFont(inputId, statusId, themeKey);
      });
      menu.append(item);
    });
    highlighted = -1;
    menu.hidden = false;
  };

  const moveHighlight = (delta) => {
    const items = [...menu.children];
    if (!items.length) return;
    highlighted = (highlighted + delta + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("active", i === highlighted));
    items[highlighted].scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", renderMenu);
  input.addEventListener("focus", renderMenu);
  input.addEventListener("blur", () => setTimeout(closeMenu, 150));

  input.addEventListener("keydown", (e) => {
    if (!menu.hidden) {
      if (e.key === "ArrowDown") return (moveHighlight(1), e.preventDefault());
      if (e.key === "ArrowUp") return (moveHighlight(-1), e.preventDefault());
      if (e.key === "Escape") return closeMenu();
      if (e.key === "Enter" && highlighted >= 0) {
        e.preventDefault();
        input.value = menu.children[highlighted].dataset.name;
        closeMenu();
        applyFont(inputId, statusId, themeKey);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      applyFont(inputId, statusId, themeKey);
    }
  });

  $(inputId + "Apply").addEventListener("click", () =>
    applyFont(inputId, statusId, themeKey),
  );
}

function wireThemeControls() {
  wireFontField("chatFont", "chatFontMenu", "chatFontStatus", "chatFont");

  // 'input' (not 'change') so sizes apply live on every keystroke/arrow.
  for (const id of SIZE_IDS) {
    $(id).addEventListener("input", () => {
      const raw = $(id).value;
      if (raw === "") return saveTheme({ [id]: null });
      const value = Number(raw);
      saveTheme({ [id]: value >= 9 && value <= 48 ? Math.round(value) : null });
    });
  }

  for (const id of PICKER_IDS) {
    const input = $(id);
    input.addEventListener("input", () => {
      input.closest(".pick-wrap").classList.remove("unset");
      saveTheme({ [id]: input.value });
    });
  }

  for (const btn of document.querySelectorAll(".pick-clear")) {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.for);
      input.value = NEUTRAL;
      input.closest(".pick-wrap").classList.add("unset");
      saveTheme({ [input.id]: "" });
    });
  }

  loadFontCatalog();
}

/* ---------- Projects (chat folders) ---------- */

function saveProjects(patch) {
  Object.assign(projectsState, patch);
  chrome.storage.local.set({ projects: projectsState });
}

function renderFolders() {
  const list = $("folderList");
  list.textContent = "";
  const folders = projectsState.folders;
  $("folderCount").textContent = String(folders.length);

  if (!folders.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const p = document.createElement("p");
    p.textContent = "No folders yet. Add one below.";
    p.style.margin = "0";
    empty.append(p);
    list.append(empty);
    return;
  }

  const counts = Object.values(projectsState.assignments).reduce((acc, f) => {
    acc[f] = (acc[f] || 0) + 1;
    return acc;
  }, {});

  folders.forEach((folder) => {
    const row = document.createElement("div");
    row.className = "frow";

    const name = document.createElement("input");
    name.type = "text";
    name.value = folder.name;
    name.spellcheck = false;
    name.addEventListener("change", () => {
      const value = name.value.trim();
      if (!value) {
        name.value = folder.name;
        return;
      }
      saveProjects({
        folders: projectsState.folders.map((f) =>
          f.id === folder.id ? { ...f, name: value } : f,
        ),
      });
    });

    const count = document.createElement("span");
    count.className = "cnt";
    count.textContent = (counts[folder.id] || 0) + " chats";

    const del = document.createElement("button");
    del.className = "icon-btn";
    del.title = "Delete folder (chats return to the main list)";
    del.innerHTML = ICONS.trash;
    del.addEventListener("click", () => {
      const assignments = { ...projectsState.assignments };
      for (const [chat, f] of Object.entries(assignments))
        if (f === folder.id) delete assignments[chat];
      saveProjects({
        folders: projectsState.folders.filter((f) => f.id !== folder.id),
        assignments,
      });
    });

    row.append(name, count, del);
    list.append(row);
  });
}

function wireProjectsControls() {
  $("projectsEnabled").addEventListener("change", (e) =>
    saveProjects({ enabled: e.target.checked }),
  );

  $("addFolderBtn").addEventListener("click", () => {
    const field = $("newFolder");
    const name = field.value.trim();
    if (!name) return field.focus();
    const id = "f" + Date.now().toString(36);
    saveProjects({
      folders: [...projectsState.folders, { id, name, collapsed: false }],
    });
    field.value = "";
    field.focus();
  });

  $("newFolder").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("addFolderBtn").click();
    }
  });
}

/* ---------- Actions ---------- */

function flash(button, message, kind) {
  const label = button.querySelector("span");
  if (!button.dataset.label) button.dataset.label = label.textContent;
  if (button.dataset.timer) clearTimeout(Number(button.dataset.timer));

  button.classList.remove("ok", "warn");
  button.classList.add(kind);
  label.textContent = message;

  button.dataset.timer = String(
    setTimeout(() => {
      button.classList.remove("ok", "warn");
      label.textContent = button.dataset.label;
      delete button.dataset.timer;
    }, 2200),
  );
}

async function init() {
  $("version").textContent = "v" + chrome.runtime.getManifest().version;

  const {
    prompts = [],
    autoSend = true,
    theme = {},
    projects = {},
    uiTab = "prompts",
  } = await chrome.storage.local.get([
    "prompts",
    "autoSend",
    "theme",
    "projects",
    "uiTab",
  ]);
  state.prompts = prompts;
  Object.assign(projectsState, projects);
  state.theme = theme;

  $("autoSend").checked = autoSend;
  $("projectsEnabled").checked = !!projects.enabled;
  render();
  syncThemeInputs();
  wireThemeControls();
  wireProjectsControls();
  renderFolders();
  switchTab(
    ["prompts", "appearance", "projects"].includes(uiTab) ? uiTab : "prompts",
  );

  // Keep multiple popup windows in sync.
  chrome.storage.onChanged.addListener(
    ({ prompts, autoSend, theme, projects }) => {
      if (prompts) {
        state.prompts = prompts.newValue || [];
        render();
      }
      if (autoSend) $("autoSend").checked = autoSend.newValue !== false;
      if (theme) {
        state.theme = theme.newValue || {};
        syncThemeInputs();
      }
      if (projects) {
        Object.assign(projectsState, projects.newValue || {});
        $("projectsEnabled").checked = !!projects.newValue?.enabled;
        renderFolders();
      }
    },
  );
}

$("autoSend").addEventListener("change", (e) =>
  chrome.storage.local.set({ autoSend: e.target.checked }),
);

$("addBtn").addEventListener("click", () => {
  const field = $("newPrompt");
  const text = field.value.trim();
  if (!text) return field.focus();
  state.prompts.push({ text, active: true });
  field.value = "";
  persistPrompts();
  field.focus();
});

$("newPrompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("addBtn").click();
  }
});

$("sendNowBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "sendNow" });
      flash(btn, "Sent!", "ok");
      return;
    } catch {
      // No content script on this tab.
    }
  }
  flash(btn, "Open chat.deepseek.com first", "warn");
});

init();
