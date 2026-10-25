/**
 * Projects / folders for DeepSeek chats.
 *
 * DeepSeek's own left sidebar is never touched. Instead the extension
 * adds a fixed drawer on the RIGHT side of the page holding the Projects
 * folders. Chats can be dragged from the native history list (left) and
 * dropped onto the folders (right); clicking a chat inside a folder
 * navigates through its native link (SPA). All state lives in
 * chrome.storage.local and syncs instantly across tabs and the popup
 * through storage.onChanged.
 */
(() => {
  if (window.__dsProjectsLoaded) return;
  window.__dsProjectsLoaded = true;

  const PANEL_ID = "__dsProjectsPanel";
  const STYLE_ID = "__dsProjectsStyle";
  const LAYOUT_ID = "__dsProjectsLayout";
  const CHAT_ANCHOR_SEL = 'a[href*="/a/chat/s/"]';
  const DND_TYPE = "application/x-ds-chat";
  const ID_RE = /^[A-Za-z0-9_-]+$/;
  const DRAWER_W = 290; // ~25% wider than the original 232px
  const SLIVER_W = 26; // visible sliver while collapsed

  const chatIdFromPath = (path) => {
    const m = String(path || "").match(/\/a\/chat\/s\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  };

  let state = {
    enabled: false,
    collapsed: false, // drawer collapsed to a slim tab
    folders: [],
    assignments: {},
    titles: {},
  };
  let lastRenderSig = "";

  // ---------- state ----------

  async function loadState() {
    const { projects = {} } = await chrome.storage.local.get("projects");
    state = {
      enabled: !!projects.enabled,
      collapsed: !!projects.collapsed,
      folders: Array.isArray(projects.folders) ? projects.folders : [],
      assignments: projects.assignments || {},
      titles: projects.titles || {},
    };
    apply();
  }

  function saveState(patch) {
    state = { ...state, ...patch };
    chrome.storage.local.set({ projects: state });
    apply();
  }

  // ---------- static styles ----------

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    // Flat styling, unified with the popup: one flat surface, no
    // shadows, hairline separators, blue selection accents. No fixed
    // font sizes or families here: the drawer adopts the page font
    // from the global theme (content.js) like everything else.
    el.textContent = `
      #__dsProjectsPanel{
        --bg:#23252b;--hover:#2c2f37;--sel:#1e6fe8;--text:#e8e6e3;
        --mut:#8b8f98;--hair:rgba(255,255,255,0.09);--red:#ff6b62;
        --tint:rgba(30,111,232,0.16);
      }
      body:not([data-ds-dark-theme]) #__dsProjectsPanel{
        --bg:#efeaea;--hover:#e4dedf;--text:#1c1b1c;--mut:#9a938f;
        --hair:rgba(214,208,206,0.6);--red:#ff3b30;
        --tint:rgba(30,111,232,0.08);
      }

      #__dsProjectsPanel{
        position:fixed;top:0;right:0;bottom:0;
        width:${DRAWER_W}px;z-index:2147483000;
        display:flex;flex-direction:column;
        background:var(--bg);border-left:1px solid var(--hair);
        color:var(--text);
        transition:transform .2s ease;
      }
      #__dsProjectsPanel.dst-collapsed{
        transform:translateX(calc(100% - ${SLIVER_W}px));}
      #__dsProjectsPanel.dst-collapsed .dst-inner{
        pointer-events:none;opacity:0;}

      .dst-inner{
        display:flex;flex-direction:column;flex:1;min-width:0;
        transition:opacity .15s ease}
      .dst-bar{display:flex;align-items:center;gap:4px;padding:14px 12px 8px}
      .dst-title{flex:1;font-weight:600;color:var(--text)}
      .dst-body{flex:1;overflow-y:auto;scrollbar-width:thin;padding:0 2px 14px}
      .dst-handle{
        position:absolute;left:0;top:50%;transform:translateY(-50%);
        width:22px;height:72px;
        display:grid;place-items:center;
        border:none;border-radius:8px 0 0 8px;cursor:pointer;
        background:var(--bg);border-left:1px solid var(--hair);
        color:var(--mut);
        transition:background .15s ease,color .15s ease;
      }
      .dst-handle:hover{background:var(--hover);color:var(--sel)}

      /* Hairline separators, same as the popup */
      .dst-sep{height:1px;background:var(--hair);margin:7px 12px}

      #__dsProjectsPanel button{
        border:none;background:none;color:inherit;
        cursor:pointer;padding:0}
      .dst-iconbtn{
        width:24px;height:24px;display:grid;place-items:center;
        border-radius:6px;color:var(--mut)}
      .dst-iconbtn:hover{background:var(--hover);color:var(--sel)}

      .dst-folder{border-radius:8px;margin:0 8px;background:transparent}
      .dst-folder:hover{background:var(--hover)}
      .dst-folder.dst-over{
        background:var(--tint);
        box-shadow:inset 0 0 0 1px var(--sel)}
      .dst-fhead{display:flex;align-items:center;gap:6px;padding:8px 10px}
      .dst-ftoggle{
        flex:1;display:flex;align-items:center;gap:6px;
        min-width:0;text-align:left}
      .dst-chev{color:var(--mut);transition:transform .15s ease;
        display:inline-block}
      .dst-chev.dst-open{transform:rotate(90deg)}
      .dst-fname{
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-weight:600}
      .dst-fcount{
        padding:1px 8px;border-radius:999px;background:var(--sel);
        color:#fff;font-size:10px;font-weight:600}
      .dst-chats:empty{display:none}
      .dst-chat{
        display:flex;align-items:center;justify-content:space-between;
        gap:6px;padding:6px 10px 6px 24px;border-radius:6px;
        color:inherit;text-decoration:none;cursor:pointer}
      .dst-chat:hover{background:var(--hover)}
      .dst-chat.dst-active{background:var(--sel);color:#fff}
      .dst-chat-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dst-chat-x{
        width:16px;height:16px;display:grid;place-items:center;
        border-radius:4px;color:var(--mut);flex-shrink:0;opacity:0}
      .dst-chat:hover .dst-chat-x{opacity:1}
      .dst-chat.dst-active .dst-chat-x{opacity:1;color:#fff}
      .dst-chat-x:hover{color:var(--red)}
      .dst-hint{color:var(--mut);padding:4px 14px 2px}
    `;
    document.head.appendChild(el);
  }

  // Reserves the drawer's space WITHOUT moving the whole page.
  function syncLayoutStyle() {
    const width = state.collapsed ? SLIVER_W : DRAWER_W;
    let el = document.getElementById(LAYOUT_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = LAYOUT_ID;
      document.head.appendChild(el);
    }
    el.textContent = `
      :root { --dst-shift: ${width}px; }
      .ds-floating-container {
        translate: calc(-1 * var(--dst-shift, 0px)) 0 !important;
        transition: translate .2s ease;
      }
      .dst-rshift {
        translate: calc(-1 * var(--dst-shift, 0px)) 0 !important;
        transition: translate .2s ease;
      }
      .dst-rcancel {
        translate: calc(var(--dst-shift, 0px)) 0 !important;
      }
    `;
  }

  const SHIFT_CLASS = "dst-rshift";
  const CANCEL_CLASS = "dst-rcancel";
  const FLOATING_WRAP = ".ds-floating-position-wrapper";
  const FLOATING_LAYER = ".ds-floating-container";
  const shiftedEls = new Set(); // individually shifted fixed widgets
  const canceledEls = new Set(); // non-right floating widgets compensated

  function syncRightPinned() {
    const foundShift = new Set();
    const foundCancel = new Set();

    if (state.enabled) {
      const vw = window.innerWidth;
      const shift = state.collapsed ? SLIVER_W : DRAWER_W;
      const effectiveRight = vw - shift; // the new "viewport edge"

      // 1) Floating widgets: right-anchored ones ride the layer shift;
      //    anything else (center/left) is compensated back.
      for (const wrap of document.querySelectorAll(FLOATING_WRAP)) {
        const rect = wrap.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right >= effectiveRight - 250) continue; // right edge
        foundCancel.add(wrap);
      }

      // 2) Generic sweep for fixed point widgets outside the floating
      //    layer (the layer's own children are handled above).
      if (typeof document.elementsFromPoint === "function") {
        const vh = window.innerHeight;
        const xs = [8, 40, 80, 120, 170].map((d) => vw - d);
        const ys = [];
        for (let y = 60; y < vh - 40; y += 70) ys.push(y);

        for (const x of xs) {
          for (const y of ys) {
            for (const el of document.elementsFromPoint(x, y)) {
              if (!(el instanceof Element) || foundShift.has(el)) continue;
              if (el.closest?.(`#${PANEL_ID}`)) continue;
              if (el.closest?.(FLOATING_LAYER)) continue; // layer handles it
              const cs = getComputedStyle(el);
              if (cs.position !== "fixed") continue;
              const rect = el.getBoundingClientRect();
              if (rect.width > vw * 0.5) continue; // full-width bars stay
              if (rect.right < effectiveRight - 250) continue;
              foundShift.add(el);
            }
          }
        }
      }
    }

    for (const el of shiftedEls) {
      if (!foundShift.has(el)) {
        el.classList.remove(SHIFT_CLASS);
        shiftedEls.delete(el);
      }
    }
    for (const el of foundShift) {
      if (!shiftedEls.has(el)) {
        el.classList.add(SHIFT_CLASS);
        shiftedEls.add(el);
      }
    }
    for (const el of canceledEls) {
      if (!foundCancel.has(el)) {
        el.classList.remove(CANCEL_CLASS);
        canceledEls.delete(el);
      }
    }
    for (const el of foundCancel) {
      if (!canceledEls.has(el)) {
        el.classList.add(CANCEL_CLASS);
        canceledEls.add(el);
      }
    }
  }

  // ---------- rendering ----------

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  const anchorTitle = (a) =>
    (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);

  const chatsOf = (folderId) =>
    Object.entries(state.assignments)
      .filter(([, f]) => f === folderId)
      .map(([id]) => ({
        id,
        title: state.titles[id] || "Chat " + id.slice(0, 8),
      }));

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const activeId = chatIdFromPath(location.pathname);

    const folders = state.folders
      .map((f) => {
        const chats = chatsOf(f.id);
        const open = !f.collapsed;
        const items = open
          ? chats
              .map(
                (c) => `
        <a class="dst-chat${c.id === activeId ? " dst-active" : ""}"
           data-chat="${esc(c.id)}" title="${esc(c.title)}">
          <span class="dst-chat-name">${esc(c.title)}</span>
          <button class="dst-chat-x" data-unfile="${esc(c.id)}"
                 title="Remove from folder">&times;</button>
        </a>`,
              )
              .join("")
          : "";
        return `
        <div class="dst-folder" data-folder="${esc(f.id)}">
          <div class="dst-fhead">
            <button class="dst-ftoggle" data-toggle="${esc(f.id)}"
                   title="${open ? "Collapse" : "Expand"}">
              <span class="dst-chev${open ? " dst-open" : ""}">
                <svg width="10" height="10" viewBox="0 0 24 24"
                     fill="none" stroke="currentColor" stroke-width="2.6"
                     stroke-linecap="round" stroke-linejoin="round">
                  <path d="m9 6 6 6-6 6"/>
                </svg></span>
              <span class="dst-fname">${esc(f.name)}</span>
            </button>
            <span class="dst-fcount">${chats.length}</span>
          </div>
          <div class="dst-chats">${items}</div>
        </div>`;
      })
      .join('<div class="dst-sep"></div>');

    const chevron = state.collapsed
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round" stroke-linejoin="round">
           <path d="m15 6-6 6 6 6"/>
         </svg>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round" stroke-linejoin="round">
           <path d="m9 6 6 6-6 6"/>
         </svg>`;

    panel.innerHTML = `
      <button class="dst-handle" data-collapse
              title="${state.collapsed ? "Expand" : "Collapse"}">
        ${chevron}
      </button>
      <div class="dst-inner">
        <div class="dst-bar">
          <span class="dst-title">Projects</span>
          <button class="dst-iconbtn" data-add title="New folder">+</button>
        </div>
        <div class="dst-sep"></div>
        <div class="dst-body">
          ${
            folders ||
            '<div class="dst-hint">No folders yet. Drag chats here.</div>'
          }
        </div>
      </div>
    `;
    panel.classList.toggle("dst-collapsed", state.collapsed);
  }

  // ---------- DOM integration ----------

  function mountPanel() {
    if (document.getElementById(PANEL_ID)) return true;
    // Own fixed drawer on the right; DeepSeek's left sidebar is untouched.
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
    wire(panel);
    return true;
  }

  function unmount() {
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(LAYOUT_ID)?.remove();
    for (const el of shiftedEls) el.classList?.remove(SHIFT_CLASS);
    for (const el of canceledEls) el.classList?.remove(CANCEL_CLASS);
    shiftedEls.clear();
    canceledEls.clear();
  }

  // ---------- mutations ----------

  function file(chatId, folderId) {
    if (!ID_RE.test(chatId)) return;
    if (!state.folders.some((f) => f.id === folderId)) return;
    if (state.assignments[chatId] === folderId) return;
    saveState({ assignments: { ...state.assignments, [chatId]: folderId } });
  }

  function unfile(chatId) {
    if (!(chatId in state.assignments)) return;
    const assignments = { ...state.assignments };
    delete assignments[chatId];
    saveState({ assignments });
  }

  function toggleFolder(id) {
    saveState({
      folders: state.folders.map((f) =>
        f.id === id ? { ...f, collapsed: !f.collapsed } : f,
      ),
    });
  }

  function newFolder() {
    const id = "f" + Date.now().toString(36);
    let name = "New folder";
    let n = 2;
    while (state.folders.some((f) => f.name === name))
      name = "New folder " + n++;
    saveState({ folders: [...state.folders, { id, name, collapsed: false }] });
  }

  function openChat(id) {
    // Navigate through the untouched native link when possible.
    const anchor = document.querySelector(`a[href*="/a/chat/s/${id}"]`);
    if (anchor) anchor.click();
    else location.href = "/a/chat/s/" + id;
  }

  function apply() {
    if (!state.enabled) {
      unmount();
      return;
    }
    ensureStyle();
    mountPanel();
    syncLayoutStyle();
    renderPanel();
    syncRightPinned();
  }

  // ---------- drag & drop ----------

  window.addEventListener(
    "dragstart",
    (e) => {
      const anchor = e.target?.closest?.(CHAT_ANCHOR_SEL);
      if (!anchor) return;
      const id = chatIdFromPath(anchor.getAttribute("href"));
      if (id) e.dataTransfer.setData(DND_TYPE, id);
    },
    true,
  );

  const dragPayload = (dt) => {
    const custom = dt.getData(DND_TYPE);
    if (ID_RE.test(custom)) return custom;
    return chatIdFromPath(
      dt.getData("text/uri-list") || dt.getData("text/plain"),
    );
  };

  function wire(root) {
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-collapse]")) {
        saveState({ collapsed: !state.collapsed });
        return;
      }
      const unfileBtn = e.target.closest("[data-unfile]");
      if (unfileBtn) {
        e.preventDefault();
        e.stopPropagation();
        unfile(unfileBtn.dataset.unfile);
        return;
      }
      const toggle = e.target.closest("[data-toggle]");
      if (toggle) return toggleFolder(toggle.dataset.toggle);
      if (e.target.closest("[data-add]")) return newFolder();
      const chat = e.target.closest(".dst-chat");
      if (chat) {
        e.preventDefault();
        openChat(chat.dataset.chat);
      }
    });

    root.addEventListener("dragover", (e) => {
      const folder = e.target.closest(".dst-folder");
      if (!folder) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      folder.classList.add("dst-over");
    });

    root.addEventListener("dragleave", (e) => {
      e.target.closest(".dst-folder")?.classList.remove("dst-over");
    });

    root.addEventListener("drop", (e) => {
      const folder = e.target.closest(".dst-folder");
      if (!folder) return;
      e.preventDefault();
      folder.classList.remove("dst-over");
      file(dragPayload(e.dataTransfer), folder.dataset.folder);
    });
  }

  // ---------- self-healing observer ----------

  function renderSoon() {
    const sig = JSON.stringify([
      state.folders,
      state.assignments,
      state.titles,
      state.collapsed,
      chatIdFromPath(location.pathname),
    ]);
    if (sig !== lastRenderSig) {
      lastRenderSig = sig;
      renderPanel();
    }
  }

  function maintain() {
    if (!state.enabled) return;
    if (!mountPanel()) return;

    // Keep filed-chat titles fresh from the native list.
    let titles = state.titles;
    let dirty = false;
    for (const anchor of document.querySelectorAll(CHAT_ANCHOR_SEL)) {
      const id = chatIdFromPath(anchor.getAttribute("href"));
      if (!id || !(id in state.assignments)) continue;
      const title = anchorTitle(anchor);
      if (title && titles[id] !== title) {
        titles = { ...titles, [id]: title };
        dirty = true;
      }
    }
    if (dirty) {
      state.titles = titles;
      chrome.storage.local.set({ projects: state });
    }

    renderSoon();
    syncRightPinned();
  }

  let domTimer;
  new MutationObserver(() => {
    clearTimeout(domTimer);
    domTimer = setTimeout(maintain, 300);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.projects) loadState();
  });

  loadState();
})();
