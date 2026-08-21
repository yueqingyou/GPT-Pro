const PROJECT_RESTRICTED_TEST_IDS = new Map([
  ["share-chat-button", "share"],
  ["share-chat-menu-item", "share"],
  ["share-prompt-link-turn-action-button", "share"],
]);
const PROJECT_RESTRICTED_ARIA_LABELS = new Map([
  ["share", "share"],
  ["分享", "share"],
  ["show project details", "project controls"],
]);
const PROJECT_RESTRICTED_MENU_LABELS = new Map([
  ["share", "share"],
  ["move to project", "project controls"],
  ["remove from project", "project controls"],
]);
const ADD_SOURCE_ALLOWLIST = new Set(["upload", "text input"]);
const PROJECT_RESTRICTED_SELECTORS = [
  'a[href^="/g/"][href$="/project"]',
  'button[data-testid="share-chat-button"]',
  '[data-testid="share-chat-menu-item"]',
  'button[data-testid="share-prompt-link-turn-action-button"]',
  'button[data-testid="open-sidebar-button"]',
  'button[aria-label="Share" i]',
  'button[aria-label="分享"]',
  'button[aria-label="Show project details"]',
];

const FOCUS_STYLE = `
${PROJECT_RESTRICTED_SELECTORS.join(",\n")},
div:has(> div > button[data-testid="open-sidebar-button"]) > div.pointer-events-none.absolute,
#stage-sidebar-tiny-bar,
#stage-slideover-sidebar,
aside[aria-label*="sidebar" i],
aside[aria-label*="侧边栏"],
nav:has([data-testid="create-new-chat-button"]),
[data-testid="create-new-chat-button"],
[data-testid="close-sidebar-button"],
[data-testid^="sidebar-item-"],
[data-testid*="voice" i],
[data-testid*="speech" i],
button[aria-label="Open sidebar" i],
button[aria-label="Close sidebar" i],
button[aria-label*="voice" i],
button[aria-label*="dictation" i],
button[aria-label*="语音"],
button[aria-label*="听写"],
button[aria-label*="麦克风"],
button[data-testid="project-modal-trigger"],
button[aria-label^="Edit the title of " i],
button[aria-label*="编辑"][aria-label*="标题"],
[data-gpc-composer-tool-hidden="true"],
[data-gpc-project-focus-hidden="true"] {
  display: none !important;
}
`;

export const DEFAULT_COMPOSER_TOOL_ALLOWLIST = Object.freeze([
  "Add photos & files",
  "Create image",
  "Web search",
  "Deep research",
]);

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function composerToolKey(raw) {
  return String(raw || "").trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function normalizeComposerToolAllowlist(raw) {
  if (!Array.isArray(raw)) throw fail("编辑器功能白名单必须是数组");
  if (raw.length > 64) throw fail("编辑器功能白名单最多 64 项");
  const names = [];
  const seen = new Set();
  for (const value of raw) {
    const name = String(value || "").trim();
    if (!name) continue;
    if (name.length > 80) throw fail("编辑器功能名称不能超过 80 个字符");
    if (/\p{Cc}/u.test(name)) throw fail("编辑器功能名称不能包含控制字符");
    const key = composerToolKey(name);
    if (!seen.has(key)) names.push(name);
    seen.add(key);
  }
  return names;
}

export function projectScopeFromUrl(raw) {
  const url = new URL(raw);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "g" && parts[1] && ["project", "c"].includes(parts[2])) {
    return { origin: url.origin, id: parts[1] };
  }
  return null;
}

function projectHome(scope, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  return parts.length === 3 && parts[0] === "g" && parts[1] === scope.id && parts[2] === "project";
}

function projectConversation(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "g" || !parts[1] || parts[2] !== "c" || !parts[3]) return null;
  return parts[3];
}

export function projectNavigationAllowed(scope, raw, currentRaw) {
  let url;
  let current;
  try {
    url = new URL(raw);
    if (!scope) return url.origin === "https://chatgpt.com";
    current = new URL(currentRaw);
  } catch {
    return false;
  }
  if (url.origin !== scope.origin) return false;
  if (projectHome(scope, url)) return true;
  const conversation = projectConversation(url);
  if (!conversation || current.origin !== scope.origin) return false;
  if (projectHome(scope, current)) return true;
  return projectConversation(current) === conversation;
}

export function projectRestrictedActionMatch(scope, action, allowedTools = DEFAULT_COMPOSER_TOOL_ALLOWLIST) {
  const controlName = composerToolKey(action?.controlName);
  if (action?.surface === "composer-tool") {
    const submenu = action?.submenu === true && controlName === "more";
    const allowed = allowedTools.some((name) => composerToolKey(name) === controlName);
    if (!submenu && !allowed) return "workspace tool";
  }
  if (action?.surface === "add-source" && !ADD_SOURCE_ALLOWLIST.has(controlName)) return "workspace tool";
  const tagName = String(action?.tagName || "").toLocaleLowerCase("en-US");
  if (tagName === "a" && scope && action?.href) {
    try {
      if (projectHome(scope, new URL(action.href))) return "project controls";
    } catch {
      return "";
    }
  }
  const role = String(action?.role || "").toLocaleLowerCase("en-US");
  if (tagName !== "button" && !["menuitem", "menuitemradio"].includes(role)) return "";
  const testId = String(action?.testId || "").toLocaleLowerCase("en-US");
  const ariaLabel = composerToolKey(action?.ariaLabel);
  const text = composerToolKey(action?.text);
  return (
    PROJECT_RESTRICTED_TEST_IDS.get(testId) ||
    PROJECT_RESTRICTED_ARIA_LABELS.get(ariaLabel) ||
    PROJECT_RESTRICTED_MENU_LABELS.get(text) ||
    ""
  );
}

export function projectFocusScript(allowedTools = DEFAULT_COMPOSER_TOOL_ALLOWLIST) {
  const allowlist = normalizeComposerToolAllowlist(allowedTools).map(composerToolKey);
  return `(() => {
    const normalize = (value) => String(value || "").trim().normalize("NFKC").toLocaleLowerCase("en-US");
    const allowedTools = new Set(${JSON.stringify(allowlist)});
    const allowedSources = new Set(${JSON.stringify([...ADD_SOURCE_ALLOWLIST])});
    const restrictedMenuLabels = new Set(${JSON.stringify([...PROJECT_RESTRICTED_MENU_LABELS.keys()])});
    const hiddenAttribute = "data-gpc-composer-tool-hidden";
    const focusHiddenAttribute = "data-gpc-project-focus-hidden";
    const install = () => {
      if (!document.documentElement) return;
      let style = document.querySelector("style[data-gpc-project-focus]");
      if (!style) {
        style = document.createElement("style");
        style.dataset.gpcProjectFocus = "true";
        (document.head || document.documentElement).append(style);
      }
      style.textContent = ${JSON.stringify(FOCUS_STYLE)};
      const select = (root, selector) => {
        const matches = root instanceof Element && root.matches(selector) ? [root] : [];
        if (root?.querySelectorAll) matches.push(...root.querySelectorAll(selector));
        return matches;
      };
      const composerMenu = (menu) => {
        let current = menu;
        while (current?.id) {
          const trigger = document.querySelector('[aria-controls="' + CSS.escape(current.id) + '"]');
          if (!trigger) return false;
          if (trigger.matches('[data-testid="composer-plus-btn"]')) return true;
          current = trigger.closest('[role="menu"]');
        }
        return false;
      };
      const apply = (root) => {
        for (const menu of select(root, '[role="menu"].popover')) {
          if (!composerMenu(menu)) continue;
          for (const item of menu.querySelectorAll(".__menu-item")) {
            const name = normalize(item.querySelector(".truncate, .line-clamp-1")?.textContent);
            const submenu = item.getAttribute("aria-haspopup") === "menu" && name === "more";
            if (!submenu && !allowedTools.has(name)) item.setAttribute(hiddenAttribute, "true");
          }
        }
        for (const dialog of select(root, '[role="dialog"]')) {
          if (normalize(dialog.querySelector("h2")?.textContent) !== "add sources") continue;
          for (const source of dialog.querySelectorAll('button:not([data-testid="close-button"])')) {
            if (!allowedSources.has(normalize(source.textContent))) source.setAttribute(focusHiddenAttribute, "true");
          }
        }
        for (const radio of select(root, 'button[role="radio"]')) {
          const label = String(radio.textContent || "").trim().toLocaleLowerCase("en-US");
          if (!["chat", "work", "聊天", "工作"].includes(label)) continue;
          const group = radio.parentElement;
          const labels = [...(group?.querySelectorAll(':scope > button[role="radio"]') || [])]
            .map((item) => String(item.textContent || "").trim().toLocaleLowerCase("en-US"));
          if (labels.some((item) => ["chat", "聊天"].includes(item)) && labels.some((item) => ["work", "工作"].includes(item))) {
            group.setAttribute(focusHiddenAttribute, "true");
          }
        }
        for (const item of select(root, '[role="menuitem"]')) {
          if (restrictedMenuLabels.has(normalize(item.textContent))) item.setAttribute(focusHiddenAttribute, "true");
        }
      };
      for (const element of document.querySelectorAll("[" + hiddenAttribute + "]")) element.removeAttribute(hiddenAttribute);
      for (const element of document.querySelectorAll("[" + focusHiddenAttribute + "]")) element.removeAttribute(focusHiddenAttribute);
      apply(document);
      if (globalThis.__gpcProjectFocusObserver) globalThis.__gpcProjectFocusObserver.disconnect();
      const roots = new Set();
      let pending = false;
      const queue = (root) => {
        if (root) roots.add(root.closest?.(".popover") || root);
        if (pending) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          for (const root of roots) apply(root);
          roots.clear();
        });
      };
      globalThis.__gpcProjectFocusObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) queue(node instanceof Element ? node : node.parentElement);
        }
      });
      globalThis.__gpcProjectFocusObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    };
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", install, { once: true });
    else install();
    return true;
  })()`;
}
