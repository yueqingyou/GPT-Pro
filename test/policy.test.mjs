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
  assert.equal(sensitiveActionMatch(policy, "Open profile menu"), "profile menu");
  assert.equal(sensitiveActionMatch(policy, "退出登录"), "退出登录");
  assert.equal(sensitiveActionMatch(policy, "Settings"), "settings");
  assert.match(sensitiveUrlMatch(policy, "https://chatgpt.com/api/auth/logout?return=/"), /logout/);
  assert.equal(sensitiveActionMatch({ ...policy, enabled: false }, "退出登录"), "");
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
  const script = sensitiveGuardScript(policy);
  assert.match(script, /__gpcSensitiveGuard/);
  assert.match(script, /contenteditable/);
  assert.match(script, /role='textbox'/);
  assert.match(script, /data-gpc-sensitive-hidden/);
  assert.match(script, /MutationObserver/);
  assert.doesNotMatch(script, /preventDefault|stopImmediatePropagation|__gpcPolicyBlocked/);
  assert.doesNotThrow(() => new Function(script));
  const expression = sensitiveActionInspectExpression("target");
  assert.match(expression, /inspectSensitiveAction/);
  assert.match(expression, /target/);
  assert.doesNotMatch(expression, /__gpcSensitiveGuard/);
  assert.doesNotThrow(() => new Function(`const target = null; return ${expression};`));
  assert.throws(
    () => normalizeSensitivePolicy({ enabled: true, actionPatterns: ["x".repeat(181)], urlPatterns: [] }),
    /不能超过/,
  );
});
