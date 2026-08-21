const MAX_PATTERNS = 128;
const MAX_PATTERN_LENGTH = 180;
const ACTION_CANDIDATE_SELECTOR =
  "a,button,[role='button'],[role='menuitem'],[role='link'],[role='textbox'],[contenteditable='true'],[tabindex],input,label,textarea";

function inspectSensitiveAction(element, candidateSelector) {
  if (!(element instanceof Element)) {
    return { description: "", tagName: "", role: "", text: "", ariaLabel: "", testId: "", href: "" };
  }
  const candidate = element.closest(candidateSelector) || element;
  const text = String(candidate.textContent || "").trim().slice(0, 512);
  const description = [
    text,
    candidate.getAttribute("aria-label"),
    candidate.getAttribute("title"),
    candidate.getAttribute("href"),
    candidate.getAttribute("data-testid"),
    candidate.getAttribute("name"),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2048);
  return {
    description,
    tagName: candidate.tagName.toLocaleLowerCase("en-US"),
    role: candidate.getAttribute("role") || "",
    text,
    ariaLabel: candidate.getAttribute("aria-label") || "",
    testId: candidate.getAttribute("data-testid") || "",
    href: candidate.closest("a[href]")?.href || "",
  };
}

export const DEFAULT_SENSITIVE_ACTION_PATTERNS = Object.freeze([
  "profile menu",
  "account menu",
  "user menu",
  "open profile",
  "profile-button",
  "account-menu",
  "user-menu",
  "个人资料菜单",
  "账户菜单",
  "帐号菜单",
  "用户菜单",
  "settings",
  "设置",
  "log out",
  "logout",
  "sign out",
  "退出登录",
  "退出账号",
  "退出帐号",
  "登出",
  "delete account",
  "deactivate account",
  "删除账户",
  "删除账号",
  "删除帐号",
  "注销账户",
  "注销账号",
  "manage subscription",
  "cancel subscription",
  "manage plan",
  "upgrade plan",
  "billing",
  "payment method",
  "管理订阅",
  "取消订阅",
  "管理套餐",
  "升级套餐",
  "账单",
  "付款方式",
  "security",
  "multi-factor",
  "two-factor",
  "passkey",
  "安全设置",
  "多重身份验证",
  "双重验证",
  "通行密钥",
  "export data",
  "delete all chats",
  "archive all chats",
  "导出数据",
  "删除所有聊天",
  "归档所有聊天",
  "custom instructions",
  "manage memory",
  "data controls",
  "personalization",
  "自定义指令",
  "管理记忆",
  "数据控制",
  "个性化",
  "connectors",
  "connected apps",
  "连接器",
  "已连接的应用",
]);

export const DEFAULT_SENSITIVE_URL_PATTERNS = Object.freeze([
  "*://chatgpt.com/*logout*",
  "*://chatgpt.com/*signout*",
  "*://chatgpt.com/*sign-out*",
  "*://auth.openai.com/*logout*",
  "*://auth.openai.com/*signout*",
  "*://auth.openai.com/*sign-out*",
  "*://chatgpt.com/*delete-account*",
  "*://chatgpt.com/*deactivate-account*",
]);

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizePatternList(raw, label) {
  if (!Array.isArray(raw)) throw fail(`${label}必须是数组`);
  if (raw.length > MAX_PATTERNS) throw fail(`${label}最多 ${MAX_PATTERNS} 条`);
  const result = [];
  const seen = new Set();
  for (const value of raw) {
    const pattern = String(value || "").trim();
    if (!pattern) continue;
    if (pattern.length > MAX_PATTERN_LENGTH) throw fail(`${label}单条不能超过 ${MAX_PATTERN_LENGTH} 个字符`);
    if (/\p{Cc}/u.test(pattern)) throw fail(`${label}不能包含控制字符`);
    const key = pattern.toLocaleLowerCase("en-US");
    if (!seen.has(key)) result.push(pattern);
    seen.add(key);
  }
  return result;
}

export function defaultSensitivePolicy() {
  return {
    enabled: true,
    actionPatterns: [...DEFAULT_SENSITIVE_ACTION_PATTERNS],
    urlPatterns: [...DEFAULT_SENSITIVE_URL_PATTERNS],
    updatedAt: null,
  };
}

export function normalizeSensitivePolicy(raw) {
  if (!raw || typeof raw !== "object") throw fail("敏感操作黑名单结构无效");
  return {
    enabled: raw.enabled !== false,
    actionPatterns: normalizePatternList(raw.actionPatterns, "页面操作黑名单"),
    urlPatterns: normalizePatternList(raw.urlPatterns, "网络 URL 黑名单"),
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
  };
}

export function wildcardMatch(value, rawPattern) {
  const text = String(value || "").toLocaleLowerCase("en-US");
  const pattern = String(rawPattern || "").toLocaleLowerCase("en-US");
  if (!pattern) return false;
  if (!pattern.includes("*")) return text === pattern;
  const parts = pattern.split("*");
  let offset = 0;
  if (!pattern.startsWith("*")) {
    const first = parts.shift() || "";
    if (!text.startsWith(first)) return false;
    offset = first.length;
  }
  const tail = pattern.endsWith("*") ? null : parts.pop() || "";
  for (const part of parts) {
    if (!part) continue;
    const found = text.indexOf(part, offset);
    if (found < 0) return false;
    offset = found + part.length;
  }
  if (tail == null) return true;
  const tailOffset = text.length - tail.length;
  return tailOffset >= offset && text.endsWith(tail);
}

export function sensitiveUrlMatch(policy, url) {
  if (!policy?.enabled) return "";
  return policy.urlPatterns.find((pattern) => wildcardMatch(url, pattern)) || "";
}

export function sensitiveActionMatch(policy, value) {
  if (!policy?.enabled) return "";
  const text = String(value || "").normalize("NFKC").toLocaleLowerCase("en-US");
  return policy.actionPatterns.find((pattern) => text.includes(pattern.normalize("NFKC").toLocaleLowerCase("en-US"))) || "";
}

export function sensitiveActionInspectExpression(targetExpression) {
  return `(${inspectSensitiveAction.toString()})(${targetExpression}, ${JSON.stringify(ACTION_CANDIDATE_SELECTOR)})`;
}

export function sensitiveGuardScript(policy) {
  const initial = {
    enabled: !!policy?.enabled,
    actionPatterns: [...(policy?.actionPatterns || [])],
  };
  return `(() => {
    const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase("en-US");
    const install = () => {
      if (globalThis.__gpcSensitiveGuard) {
        globalThis.__gpcSensitiveGuard.update(${JSON.stringify(initial)});
        return;
      }
      let policy = ${JSON.stringify(initial)};
      const candidateSelector = ${JSON.stringify(ACTION_CANDIDATE_SELECTOR)};
      const hiddenAttribute = "data-gpc-sensitive-hidden";
      const inspect = ${inspectSensitiveAction.toString()};
      const match = (element) => {
        if (!policy.enabled) return "";
        const value = normalize(inspect(element, candidateSelector).description);
        return policy.actionPatterns.find((pattern) => value.includes(normalize(pattern))) || "";
      };
      const ensureStyle = () => {
        if (!document.documentElement || document.querySelector("style[data-gpc-sensitive-style]")) return;
        const style = document.createElement("style");
        style.dataset.gpcSensitiveStyle = "true";
        style.textContent = '[data-gpc-sensitive-hidden="true"] { display: none !important; }';
        (document.head || document.documentElement).append(style);
      };
      const applyHidden = (element) => {
        if (!(element instanceof Element)) return;
        const candidate = element.matches(candidateSelector) ? element : element.closest(candidateSelector);
        if (!candidate) return;
        if (match(candidate)) candidate.setAttribute(hiddenAttribute, "true");
        else candidate.removeAttribute(hiddenAttribute);
      };
      const scan = (root) => {
        ensureStyle();
        if (!root?.querySelectorAll) return;
        if (root instanceof Element && root.matches(candidateSelector)) applyHidden(root);
        for (const element of root.querySelectorAll(candidateSelector)) applyHidden(element);
      };
      const refresh = () => {
        ensureStyle();
        for (const element of document.querySelectorAll("[" + hiddenAttribute + "]")) element.removeAttribute(hiddenAttribute);
        if (policy.enabled) scan(document);
      };
      const update = (next) => {
        policy = next && typeof next === "object" ? next : policy;
        refresh();
      };
      const observe = () => {
        if (!document.documentElement) {
          addEventListener("DOMContentLoaded", observe, { once: true });
          return;
        }
        refresh();
        const roots = new Set();
        let queued = false;
        const queueScan = (root) => {
          if (root?.querySelectorAll) roots.add(root);
          if (queued) return;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            for (const candidate of roots) scan(candidate);
            roots.clear();
          });
        };
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const target = record.target instanceof Element ? record.target : record.target.parentElement;
            const candidate = target?.closest(candidateSelector);
            if (candidate) queueScan(candidate);
            for (const node of record.addedNodes || []) if (node instanceof Element) queueScan(node);
          }
        });
        observer.observe(document.documentElement, {
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["aria-label", "title", "href", "data-testid", "name"],
          subtree: true,
        });
      };
      observe();
      globalThis.__gpcSensitiveGuard = { update };
    };
    install();
  })();`;
}
