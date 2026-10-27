/**
 * DeepSeek Plus (DSP) content script.
 *
 * - Text direction (RTL/LTR) is handled by styles.css via unicode-bidi,
 *   so no extra scripting is needed for it.
 *
 * - System prompts: DeepSeek's "new chat" is a pure UI state (no URL
 *   change, no navigation event), so a MutationObserver watches the DOM.
 *   When the page shows the composer with no rendered messages, the
 *   active prompts are inserted into the input, then sent.
 *
 * - Applies the page typography (fonts.js downloads and caches Google
 *   Fonts in local storage) and widens the conversation column.
 *
 * - Thinking sections: every "Thought for ..." reasoning block is
 *   collapsed automatically as soon as it appears. A block the user
 *   expands manually is never collapsed again.
 */
(() => {
  if (window.__dsToolsLoaded) return;
  window.__dsToolsLoaded = true;

  // ========== 1) System prompt auto-send ==========

  const SENT_FLAG = "__dsPromptSent";
  const COMPOSER_SEL = 'textarea, [contenteditable="true"]';
  const MESSAGE_SEL = ".ds-message";
  const SEND_BTN_SEL =
    'button[type="submit"], button[aria-label*="send" i],' +
    ' button[data-testid*="send" i]';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function waitFor(selector, timeout = 6000) {
    return new Promise((resolve) => {
      const found = () => document.querySelector(selector);
      const el = found();
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = found();
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        resolve(found());
      }, timeout);
    });
  }

  function setInputValue(el, value) {
    if (el instanceof HTMLTextAreaElement) {
      const set = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      ).set;
      set.call(el, value);
    } else {
      el.textContent = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const composerText = (el) =>
    el instanceof HTMLTextAreaElement ? el.value : el.textContent || "";

  function clickSend(input) {
    const isEnabled = (btn) =>
      !btn.disabled && btn.getAttribute("aria-disabled") !== "true";

    // Search an expanding ancestor scope for a send button, skipping
    // buttons that are still disabled (the app enables send only after
    // the input has content).
    let scope = input.closest("form");
    for (const level of [
      scope,
      input.parentElement,
      input.parentElement?.parentElement,
      input.parentElement?.parentElement?.parentElement,
    ]) {
      if (!level) continue;
      const btn = level.querySelector(SEND_BTN_SEL);
      if (btn && isEnabled(btn)) {
        btn.click();
        return true;
      }
    }

    for (const btn of (
      scope ||
      input.parentElement?.parentElement ||
      document
    ).querySelectorAll("button")) {
      const label = (
        btn.getAttribute("aria-label") ||
        btn.textContent ||
        ""
      ).toLowerCase();
      if (isEnabled(btn) && (label.includes("send") || btn.type === "submit")) {
        btn.click();
        return true;
      }
    }

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    return false;
  }

  // Auto-send skips a non-empty composer; the manual trigger replaces it.
  async function sendPrompts(force = false) {
    const { prompts = [] } = await chrome.storage.local.get("prompts");
    const active = prompts
      .filter((p) => p.active !== false && p.text.trim())
      .map((p) => p.text.trim());
    if (!active.length) return;

    const input = await waitFor(COMPOSER_SEL);
    if (!input) return;
    if (!force && composerText(input).trim()) return; // user is typing

    await sleep(800);
    setInputValue(input, active.join("\n\n"));
    // Give the app time to register the input and enable the send button.
    await sleep(400);
    clickSend(input);

    // Retry once if the app did not clear the composer after sending;
    // the text then simply stays in the box for a manual send.
    await sleep(800);
    if (composerText(input).trim()) clickSend(input);
    sessionStorage.setItem(SENT_FLAG, "1");
  }

  // Existing conversations live under /a/chat/s/<id>: when the URL says
  // an existing chat is open, auto-send must never fire even if the
  // message list is still rendering.
  const isExistingChatUrl = () => location.pathname.startsWith("/a/chat/s/");

  // One auto-send attempt per "empty screen" episode.
  let scheduled = false;

  async function checkAndSend() {
    if (isExistingChatUrl()) {
      scheduled = false;
      return;
    }

    const input = await waitFor(COMPOSER_SEL);
    if (!input) {
      scheduled = false;
      return;
    }

    // A screen that just cleared may still be loading an existing chat's
    // messages; abort as soon as any message (or user typing) appears.
    for (let i = 0; i < 15; i++) {
      if (document.querySelector(MESSAGE_SEL) || isExistingChatUrl()) {
        scheduled = false;
        return;
      }
      if (composerText(input).trim()) {
        scheduled = false;
        return;
      }
      await sleep(200);
    }

    const { autoSend = true } = await chrome.storage.local.get("autoSend");
    if (!autoSend) return;
    await sendPrompts();
    scheduled = false;
  }

  // Called (debounced) on every DOM change: the new-chat state is a DOM
  // state, not a navigation.
  function maybeAutoSend() {
    if (document.querySelector(MESSAGE_SEL)) {
      // A conversation is visible: reset so the next new chat can
      // trigger again.
      scheduled = false;
      sessionStorage.removeItem(SENT_FLAG);
      return;
    }
    if (scheduled || isExistingChatUrl()) return;
    if (sessionStorage.getItem(SENT_FLAG)) return;
    if (!document.querySelector(COMPOSER_SEL)) return;

    scheduled = true;
    checkAndSend();
  }

  let domTimer;
  new MutationObserver(() => {
    clearTimeout(domTimer);
    domTimer = setTimeout(maybeAutoSend, 400);
  }).observe(document.body, { childList: true, subtree: true });

  // Cover the initial state; later transitions are caught by the observer.
  maybeAutoSend();

  // Manual trigger from the popup: inserts prompts into the current chat,
  // new or existing, as many times as the user wants.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.action === "sendNow") {
      sendPrompts(true).then(() => reply({ ok: true }));
      return true;
    }
  });

  // ========== 2) Page typography ==========
  //
  // One general font (name / size / optional color) applied to the whole
  // page. Defaults: Roboto 16px, color unset. The selector carries a
  // :not(#...) chain purely for specificity: the site ships some
  // !important font rules of its own, and among competing !important
  // declarations the more specific selector wins.

  const THEME_STYLE_ID = "__dsThemeStyle";
  const PAGE_SEL = "*:not(#__ds_a):not(#__ds_b):not(#__ds_c)";

  const FONT_DEFAULTS = { chatFont: "Roboto", chatSize: 16 };

  const clampSize = (v) =>
    Math.min(48, Math.max(9, Math.round(Number(v) || 0)));

  // Each declaration gets its own !important, otherwise only the last
  // one would win once the page's own styles arrive.
  const decl = (props) =>
    props.map(([prop, value]) => `${prop}: ${value} !important`).join("; ");

  const ensureFontCss = async (family) => {
    if (!family || !globalThis.DSFonts) return null;
    try {
      return await DSFonts.ensure(family);
    } catch {
      return null; // offline or fetch blocked: fall back to the site font
    }
  };

  async function applyTheme() {
    const { theme = {} } = await chrome.storage.local.get("theme");

    let el = document.getElementById(THEME_STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = THEME_STYLE_ID;
      document.head.appendChild(el);
    }

    const font = theme.chatFont || FONT_DEFAULTS.chatFont;
    const size = clampSize(theme.chatSize || FONT_DEFAULTS.chatSize);

    const rules = [];
    const fontCss = await ensureFontCss(font);
    if (fontCss) rules.push(fontCss);

    const props = [
      ["font-family", `"${font.replace(/"/g, "")}", sans-serif`],
      ["font-size", `${size}px`],
    ];
    if (theme.chatColor) props.push(["color", theme.chatColor]);
    rules.push(`${PAGE_SEL} { ${decl(props)} }`);

    el.textContent = rules.join("\n");
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.theme) applyTheme();
  });

  applyTheme();

  // ========== 3) Wider conversation column ==========
  //
  // DeepSeek constrains the chat column with the --message-list-max-width
  // custom property. The site's own value is read once and widened by
  // 25%. The applied flag (and the style element) keep re-runs from
  // compounding the increase.

  const LAYOUT_STYLE_ID = "__dsWideLayout";
  let layoutApplied = false;

  function applyWideLayout(attempt = 0) {
    if (layoutApplied || document.getElementById(LAYOUT_STYLE_ID)) return;

    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--message-list-max-width")
      .trim();
    const match = raw.match(/^([\d.]+)px$/);

    let width;
    if (match) {
      width = Math.round(parseFloat(match[1]) * 1.25);
    } else if (attempt < 5) {
      // The app's styles may not be attached yet; retry before falling back.
      return setTimeout(() => applyWideLayout(attempt + 1), 1500);
    } else {
      width = 900; // 25% over the common 720px default
    }

    const el = document.createElement("style");
    el.id = LAYOUT_STYLE_ID;
    el.textContent =
      `:root, body { --message-list-max-width: ` + `${width}px !important; }`;
    document.head.appendChild(el);
    layoutApplied = true;
  }

  applyWideLayout();

  // ========== 4) Auto-collapsed thinking sections ==========
  //
  // DeepSeek renders every "Thought for ..." reasoning block expanded,
  // which pushes the answer off screen. Each block is collapsed by one
  // click, exactly once, as soon as it exists; that covers answers that
  // are still streaming, older chats opened from history and reloads. A
  // block the user expands manually is never touched a second time.
  //
  // The site's class names are build hashes that change between
  // releases, so detection has two routes: the current hash classes for
  // block and toggle, and the site's own ARIA wiring (a toggle with
  // aria-expanded/aria-controls pointing at .ds-think-content), which
  // survives class renames.

  const THINK_BLOCK_SEL = "._74c0879";
  const THINK_TOGGLE_SEL = "._5ab5d64";
  const THINK_CONTENT_SEL = ".ds-think-content";
  const THINK_CANDIDATES =
    `${THINK_BLOCK_SEL}, ${THINK_CONTENT_SEL}, [aria-controls]`;

  // Blocks and toggles that must never be clicked again: collapsed
  // here, found collapsed already, or re-expanded by the user after the
  // one automatic click.
  const thinkDone = new WeakSet();

  const thinkVisible = (el) => el.getClientRects().length > 0;

  function collapseThinkingBlock(block, toggle, content) {
    if (thinkDone.has(block) || thinkDone.has(toggle)) return;
    if (!thinkVisible(toggle) || !content || !thinkVisible(content)) return;
    if (toggle.matches("[disabled], [aria-disabled='true']")) {
      return; // clickable only later; the scan reruns on the next change
    }
    if (toggle.getAttribute("aria-expanded") === "false") {
      // Restored chats can render blocks already collapsed.
      thinkDone.add(block);
      thinkDone.add(toggle);
      return;
    }
    // Mark before clicking: a synchronous re-render inside the click
    // must not trigger a second click on the same block.
    thinkDone.add(block);
    thinkDone.add(toggle);
    toggle.click();
  }

  function scanThinking() {
    for (const block of document.querySelectorAll(THINK_BLOCK_SEL)) {
      const toggle = [...block.querySelectorAll(THINK_TOGGLE_SEL)].find(
        (el) => !el.closest(THINK_CONTENT_SEL),
      );
      if (!toggle) continue;
      const content = [...block.children].find((el) =>
        el.matches(THINK_CONTENT_SEL),
      );
      collapseThinkingBlock(block, toggle, content);
    }

    // Fallback for renamed hash classes: any ARIA toggle that controls
    // a .ds-think-content region inside its own block.
    for (const toggle of document.querySelectorAll(
      "[aria-controls][aria-expanded]",
    )) {
      if (toggle.getAttribute("aria-expanded") === "false") continue;
      const content = document.getElementById(
        toggle.getAttribute("aria-controls"),
      );
      if (!content?.matches(THINK_CONTENT_SEL) || content.contains(toggle)) {
        continue;
      }
      const block = content.parentElement;
      if (!block || block === document.body || !block.contains(toggle)) {
        continue;
      }
      collapseThinkingBlock(block, toggle, content);
    }
  }

  // Scans are batched on a short timer so streaming text does not
  // trigger a rescan for every chunk.
  let thinkTimer = null;

  function scheduleThinkScan() {
    if (thinkTimer !== null) return;
    thinkTimer = setTimeout(() => {
      thinkTimer = null;
      scanThinking();
    }, 200);
  }

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        if (
          m.target.matches(THINK_CANDIDATES) ||
          m.target.querySelector(THINK_CANDIDATES)
        ) {
          scheduleThinkScan();
          return;
        }
      } else if (
        [...m.addedNodes].some(
          (n) =>
            n.nodeType === Node.ELEMENT_NODE &&
            (n.matches(THINK_CANDIDATES) || n.querySelector(THINK_CANDIDATES)),
        )
      ) {
        scheduleThinkScan();
        return;
      }
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "class",
      "hidden",
      "aria-hidden",
      "aria-expanded",
      "aria-controls",
      "disabled",
      "aria-disabled",
    ],
  });

  scanThinking();
})();
