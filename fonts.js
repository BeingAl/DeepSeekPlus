/**
 * Shared Google Fonts loader, used by both the popup and the content script.
 *
 * A font is fetched by family name from the Google Fonts CSS2 API, every
 * referenced woff2 file is downloaded and embedded as a data URI, and the
 * transformed CSS is cached in chrome.storage.local. Cached fonts belong to
 * this extension alone, which only ever runs on DeepSeek pages.
 *
 * Loaded as a plain script (content_scripts[0] and a <script> tag in the
 * popup), so it exposes a single global instead of using ES modules.
 */
globalThis.DSFonts = {
  storageKey(family) {
    return "fontCss:" + family.trim().toLowerCase();
  },

  // Fetches the stylesheet for a family and returns it with every font file
  // inlined, or null when the family does not exist / cannot be reached.
  async fetchEmbeddedCss(family) {
    const name = family.trim().replace(/"/g, "").split(/\s+/).join("+");
    if (!name) return null;

    const response = await fetch(
      "https://fonts.googleapis.com/css2?family=" + name + "&display=swap",
    );
    if (!response.ok) return null;
    let css = await response.text();

    const urls = [
      ...new Set(
        [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    for (const url of urls) {
      const buffer = await (await fetch(url)).arrayBuffer();
      css = css
        .split(url)
        .join("data:font/woff2;base64," + DSFonts.base64(buffer));
    }
    return css;
  },

  base64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    // String.fromCharCode must be called in chunks to avoid stack overflows.
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  },

  // Returns the embedded CSS for a family, downloading and caching it first
  // when it is not already in storage.
  async ensure(family) {
    const name = family.trim();
    if (!name) return null;

    const key = DSFonts.storageKey(name);
    const stored = (await chrome.storage.local.get(key))[key];
    if (stored) return stored;

    const css = await DSFonts.fetchEmbeddedCss(name);
    if (css) await chrome.storage.local.set({ [key]: css });
    return css;
  },
};
