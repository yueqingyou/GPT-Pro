import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMPOSER_TOOL_ALLOWLIST,
  composerMenuFromElement,
  normalizeComposerToolAllowlist,
  projectFocusScript,
  projectNavigationAllowed,
  projectRestrictedActionMatch,
  projectScopeFromUrl,
} from "../lib/focus.mjs";

test("桌面编辑器弹层按展开的加号按钮归属识别", () => {
  const trigger = {};
  const menu = {
    parentElement: {
      querySelector: (selector) => (selector.includes("composer-plus-btn") ? trigger : null),
    },
    closest: (selector) => (selector === ".popover" ? menu : null),
    querySelector: (selector) => (selector === ".__menu-item" ? {} : null),
  };
  assert.equal(composerMenuFromElement(menu), menu);
  menu.parentElement.querySelector = () => null;
  assert.equal(composerMenuFromElement(menu), null);
});

test("项目 URL 生成主文档导航 allowlist", () => {
  const home = "https://chatgpt.com/g/g-p-project123/project";
  const conversation = "https://chatgpt.com/g/g-p-chatroute456/c/conversation-1";
  const scope = projectScopeFromUrl(home);
  assert.deepEqual(scope, { origin: "https://chatgpt.com", id: "g-p-project123" });
  assert.equal(projectNavigationAllowed(scope, home, home), true);
  assert.equal(projectNavigationAllowed(scope, conversation, home), true);
  assert.equal(projectNavigationAllowed(scope, `${conversation}/canvas`, conversation), true);
  assert.equal(projectNavigationAllowed(scope, home, conversation), true);
  assert.equal(
    projectNavigationAllowed(scope, "https://chatgpt.com/g/g-p-chatroute456/c/conversation-2", conversation),
    false,
  );
  assert.equal(projectNavigationAllowed(scope, "https://chatgpt.com/g/g-p-other/project", home), false);
  assert.equal(projectNavigationAllowed(scope, "https://chatgpt.com/settings", home), false);
  assert.equal(projectNavigationAllowed(scope, "https://auth.openai.com/", home), false);
});

test("普通首页允许 ChatGPT 导航但拒绝离开站点", () => {
  assert.equal(projectScopeFromUrl("https://chatgpt.com/"), null);
  assert.equal(projectNavigationAllowed(null, "https://chatgpt.com/c/example", "https://chatgpt.com/"), true);
  assert.equal(projectNavigationAllowed(null, "https://example.com/", "https://chatgpt.com/"), false);
  assert.equal(projectScopeFromUrl("https://chatgpt.com/projects/project-1"), null);
});

test("编辑器功能白名单保存具体名称而不依赖位置", () => {
  assert.deepEqual(DEFAULT_COMPOSER_TOOL_ALLOWLIST, [
    "Add photos & files",
    "Create image",
    "Web search",
    "Deep research",
  ]);
  assert.deepEqual(normalizeComposerToolAllowlist([" GitHub ", "github", "Notion"]), ["GitHub", "Notion"]);
  assert.throws(() => normalizeComposerToolAllowlist("GitHub"), /必须是数组/);
  const source = projectFocusScript();
  for (const name of DEFAULT_COMPOSER_TOOL_ALLOWLIST) assert.ok(source.includes(name.toLocaleLowerCase("en-US")));
  assert.doesNotMatch(source, /OpenAI Developers/);
  assert.doesNotMatch(source, /slice\(\s*0\s*,\s*5\s*\)/);
  assert.match(source, /\.truncate, \.line-clamp-1/);
  assert.match(source, /data-gpc-composer-tool-hidden/);
  assert.match(source, /composer-plus-btn/);
  assert.match(source, /aria-expanded/);
  assert.match(source, /aria-controls/);
  assert.match(source, /add sources/);
  assert.match(source, /text input/);
  const custom = projectFocusScript(["GitHub"]);
  assert.match(custom, /github/);
  assert.doesNotMatch(custom, /Add photos & files/);
});

test("专注脚本覆盖侧边栏、项目编辑、编辑器功能和语音入口", () => {
  const source = projectFocusScript();
  assert.match(source, /stage-sidebar-tiny-bar/);
  assert.match(source, /stage-slideover-sidebar/);
  assert.match(source, /aside\[aria-label\*=/);
  assert.match(source, /create-new-chat-button/);
  assert.match(source, /open-sidebar-button/);
  assert.match(source, /pointer-events-none\.absolute/);
  assert.match(source, /button\[role="radio"\]/);
  assert.match(source, /voice/);
  assert.match(source, /dictation/);
  assert.match(source, /麦克风/);
  assert.match(source, /project-modal-trigger/);
  assert.match(source, /Edit the title of/);
  assert.match(source, /share-chat-button/);
  assert.match(source, /share-chat-menu-item/);
  assert.match(source, /share-prompt-link-turn-action-button/);
  assert.doesNotMatch(source, /copy-turn-action-button/);
  assert.doesNotMatch(source, /conversation-options-button/);
  assert.match(source, /Show project details/);
  assert.match(source, /href\^=\\\"\/g\//);
  assert.match(source, /move to project/);
  assert.match(source, /remove from project/);
  assert.match(source, /aria-label=\\\"Share\\\" i/);
  assert.match(source, /__menu-item/);
  assert.doesNotMatch(source, /stopImmediatePropagation|preventDefault/);
  assert.match(source, /MutationObserver/);
});

test("项目固定限制只按实测控件属性和项目首页 URL 匹配", () => {
  const scope = projectScopeFromUrl("https://chatgpt.com/g/g-p-project123/project");
  assert.equal(projectRestrictedActionMatch(scope, { tagName: "button", ariaLabel: "Share" }), "share");
  assert.equal(projectRestrictedActionMatch(scope, { tagName: "button", ariaLabel: "分享" }), "share");
  assert.equal(projectRestrictedActionMatch(scope, { tagName: "button", testId: "share-chat-button" }), "share");
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "div", role: "menuitem", testId: "share-chat-menu-item" }),
    "share",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "button", testId: "share-prompt-link-turn-action-button" }),
    "share",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "button", testId: "conversation-options-button" }),
    "",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "button", testId: "copy-turn-action-button" }),
    "",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "button", ariaLabel: "Show project details" }),
    "project controls",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "div", role: "menuitem", text: "Move to project" }),
    "project controls",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "div", role: "menuitem", text: "Remove from project" }),
    "project controls",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, {
      tagName: "a",
      href: "https://chatgpt.com/g/g-p-project123/project",
    }),
    "project controls",
  );
  assert.equal(projectRestrictedActionMatch(scope, { tagName: "button", ariaLabel: "Shared files" }), "");
  assert.equal(projectRestrictedActionMatch(scope, { tagName: "button", ariaLabel: "More" }), "");
  assert.equal(
    projectRestrictedActionMatch(scope, {
      tagName: "div",
      role: "",
      surface: "composer-tool",
      controlName: "Vercel",
    }),
    "workspace tool",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, {
      tagName: "div",
      role: "menuitemradio",
      surface: "composer-tool",
      controlName: "Cloudflare",
    }),
    "workspace tool",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, {
      tagName: "div",
      role: "menuitem",
      surface: "composer-tool",
      controlName: "More",
      submenu: true,
    }),
    "",
  );
  assert.equal(
    projectRestrictedActionMatch(
      scope,
      { tagName: "div", role: "menuitemradio", surface: "composer-tool", controlName: "GitHub" },
      ["GitHub"],
    ),
    "",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "button", surface: "add-source", controlName: "Google Drive" }),
    "workspace tool",
  );
  assert.equal(
    projectRestrictedActionMatch(scope, { tagName: "button", surface: "add-source", controlName: "Upload" }),
    "",
  );
});
