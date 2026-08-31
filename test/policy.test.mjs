import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSensitivePolicy,
  normalizeSensitivePolicy,
  sensitiveActionInspectExpression,
  sensitiveActionMatch,
  sensitiveGuardScript,
  sensitiveUrlMatch,
  wildcardMatch,
} from "../lib/policy.mjs";

test("默认黑名单覆盖退出登录、账号设置与对应网络端点", () => {
  const policy = defaultSensitivePolicy();
  assert.equal(sensitiveActionMatch(policy, { description: "Open profile menu" }, false), "profile menu");
  assert.equal(sensitiveActionMatch(policy, { description: "退出登录" }, false), "退出登录");
  assert.equal(sensitiveActionMatch(policy, { description: "Settings" }, false), "settings");
  assert.match(sensitiveUrlMatch(policy, "https://chatgpt.com/api/auth/logout?return=/"), /logout/);
  assert.equal(sensitiveActionMatch({ ...policy, enabled: false }, { description: "退出登录" }, false), "");
});

test("项目会话操作菜单不受账号级文字黑名单影响", () => {
  const policy = { ...defaultSensitivePolicy(), actionPatterns: ["delete", "settings"] };
  assert.equal(sensitiveActionMatch(policy, { description: "Delete", conversationAction: true }, true), "");
  assert.equal(sensitiveActionMatch(policy, { description: "Delete", conversationAction: true }, false), "delete");
  assert.equal(sensitiveActionMatch(policy, { description: "Settings", conversationAction: false }, true), "settings");
});

test("页面与输入检查按控件语义识别会话操作与编辑器正文", () => {
  class FakeElement {
    constructor(attributes, { menu = null, dialog = null, item = null } = {}) {
      this.attributes = attributes;
      this.menu = menu;
      this.dialog = dialog;
      this.item = item;
      this.tagName = attributes.tagName || "BUTTON";
      this.textContent = attributes.text || "";
      this.isContentEditable = attributes.contenteditable === "true";
    }

    getAttribute(name) {
      return this.attributes[name] || null;
    }

    querySelector(selector) {
      if (selector === '[data-testid="delete-conversation-confirm-button"]') {
        return this.attributes.hasDeleteConfirmation ? {} : null;
      }
      if (selector.includes("conversation-options-button")) {
        return this.attributes.hasConversationTrigger ? {} : null;
      }
      return null;
    }

    closest(selector) {
      if (selector === '[role="menu"]') return this.menu;
      if (selector === '[role="dialog"]') {
        return this.attributes.role === "dialog" ? this : this.dialog;
      }
      if (selector === "li") return this.item;
      if (selector === "a[href]") return null;
      return this;
    }
  }

  const inspect = new Function("Element", "target", `return ${sensitiveActionInspectExpression("target")};`);
  const projectTrigger = new FakeElement({ "aria-label": "Open conversation options for Project chat" });
  assert.equal(inspect(FakeElement, projectTrigger).conversationAction, true);

  const conversationTrigger = new FakeElement({ "data-testid": "conversation-options-button" });
  assert.equal(inspect(FakeElement, conversationTrigger).conversationAction, true);

  const deleteConfirmation = new FakeElement({ "data-testid": "delete-conversation-confirm-button" });
  assert.equal(inspect(FakeElement, deleteConfirmation).conversationAction, true);

  const deleteDialog = new FakeElement({ role: "dialog", tagName: "DIV", hasDeleteConfirmation: true });
  assert.equal(inspect(FakeElement, deleteDialog).conversationAction, true);

  const cancelDelete = new FakeElement({ text: "Cancel" }, { dialog: deleteDialog });
  assert.equal(inspect(FakeElement, cancelDelete).conversationAction, true);

  const settingsDialog = new FakeElement({ role: "dialog", tagName: "DIV" });
  assert.equal(inspect(FakeElement, settingsDialog).conversationAction, false);

  const conversationItem = { querySelector: () => ({}) };
  const conversationTitle = new FakeElement({ text: "Settings", tagName: "A" }, { item: conversationItem });
  assert.equal(inspect(FakeElement, conversationTitle).conversationAction, true);

  const titleEditor = new FakeElement({ name: "title-editor", tagName: "INPUT" }, { item: conversationItem });
  assert.equal(inspect(FakeElement, titleEditor).conversationAction, true);

  const conversationList = new FakeElement({ role: "tabpanel", tagName: "DIV", hasConversationTrigger: true });
  assert.equal(inspect(FakeElement, conversationList).conversationAction, true);

  const settingsPanel = new FakeElement({ role: "tabpanel", tagName: "DIV" });
  assert.equal(inspect(FakeElement, settingsPanel).conversationAction, false);

  const conversationMenu = { querySelector: () => ({}) };
  const deleteAction = new FakeElement(
    { role: "menuitem", text: "Delete", tagName: "DIV" },
    { menu: conversationMenu },
  );
  assert.equal(inspect(FakeElement, deleteAction).conversationAction, true);

  const accountAction = new FakeElement({ "aria-label": "Open profile menu", "data-testid": "accounts-profile-button" });
  assert.equal(inspect(FakeElement, accountAction).conversationAction, false);

  const pastedText = `标题在稿件和提交材料中保持统一

与商业LLM的比较措辞需要更谨慎(因为这些模型是在零样本设置下评估的)(没看懂为什么说需要谨慎)

检查标题、术语、数据集名称、图注和表格数值的一致性

确保数据可用性声明中提及的所有代码、脚本、提示词、配置文件和数据处理说明均可访问

明确说明重复的DFPO结果是基于同一检查点的重复推理，而非独立的训练运行

阐明“最佳F1”和最优演示数量是如何选择的

进行最终的语言和校对检查



附上一份单独上传的“回复审稿人”文件 Submit Revision,逐点详细回应本信中提出的问题`;
  const composer = new FakeElement({
    role: "textbox",
    contenteditable: "true",
    tagName: "DIV",
    text: pastedText,
    "aria-label": "Message ChatGPT",
  });
  const composerAction = inspect(FakeElement, composer);
  assert.equal(composerAction.text, "");
  assert.equal(composerAction.description, "Message ChatGPT");
  assert.equal(sensitiveActionMatch(defaultSensitivePolicy(), composerAction, true), "");

  const settingsEditor = new FakeElement({
    role: "textbox",
    contenteditable: "true",
    tagName: "DIV",
    text: pastedText,
    "aria-label": "Settings",
  });
  assert.equal(sensitiveActionMatch(defaultSensitivePolicy(), inspect(FakeElement, settingsEditor), true), "settings");

  const settingsButton = new FakeElement({ text: "Settings" });
  assert.equal(sensitiveActionMatch(defaultSensitivePolicy(), inspect(FakeElement, settingsButton), true), "settings");
});

test("URL 通配匹配保持顺序和首尾锚定语义", () => {
  assert.equal(wildcardMatch("https://chatgpt.com/auth/logout", "*://chatgpt.com/*logout*"), true);
  assert.equal(wildcardMatch("prefix-abc-suffix", "prefix-*suffix"), true);
  assert.equal(wildcardMatch("prefix-abc-suffix-more", "prefix-*suffix"), false);
  assert.equal(wildcardMatch("prefix-more", "prefix"), false);
});

test("黑名单归一化去重、限制输入并生成页面隐藏规则", () => {
  const policy = normalizeSensitivePolicy({
    enabled: true,
    actionPatterns: ["Settings", " settings ", "退出登录"],
    urlPatterns: ["*logout*", "*LOGOUT*"],
  });
  assert.deepEqual(policy.actionPatterns, ["Settings", "退出登录"]);
  assert.deepEqual(policy.urlPatterns, ["*logout*"]);
  const script = sensitiveGuardScript(policy, true);
  assert.match(script, /__gpcSensitiveGuard/);
  assert.match(script, /contenteditable/);
  assert.match(script, /role='textbox'/);
  assert.match(script, /data-gpc-sensitive-hidden/);
  assert.match(script, /allowConversationActions/);
  assert.match(script, /MutationObserver/);
  assert.doesNotMatch(script, /preventDefault|stopImmediatePropagation|__gpcPolicyBlocked/);
  assert.doesNotThrow(() => new Function(script));
  const expression = sensitiveActionInspectExpression("target");
  assert.match(expression, /inspectSensitiveAction/);
  assert.match(expression, /target/);
  assert.match(expression, /conversation-options-button/);
  assert.match(expression, /Open conversation options for/);
  assert.match(expression, /delete-chat-menu-item/);
  assert.match(expression, /delete-conversation-confirm-button/);
  assert.doesNotMatch(expression, /__gpcSensitiveGuard/);
  assert.doesNotThrow(() => new Function(`const target = null; return ${expression};`));
  assert.throws(
    () => normalizeSensitivePolicy({ enabled: true, actionPatterns: ["x".repeat(181)], urlPatterns: [] }),
    /不能超过/,
  );
});
