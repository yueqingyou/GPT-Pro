import assert from "node:assert/strict";
import test from "node:test";
import { installAdministratorPaste } from "../gateway/web/admin-browser.js";
import { attachNativeTextInput, remoteModifiers, shouldForwardKey } from "../gateway/web/text-input.js";

class FakeInput extends EventTarget {
  constructor() {
    super();
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.ownerDocument = {
      activeElement: null,
      execCommand: (command) => {
        this.executedCommand = command;
        this.focusedDuringCommand = this.ownerDocument.activeElement === this;
        return command === "copy";
      },
    };
  }

  focus(options) {
    this.focusOptions = options;
    this.focused = true;
    this.ownerDocument.activeElement = this;
  }

  blur() {
    this.focused = false;
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

function emit(input, type, values = {}) {
  const event = new Event(type);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
  input.dispatchEvent(event);
}

test("英文、中文、表情与粘贴文本直接提交本机浏览器输出", () => {
  const input = new FakeInput();
  const committed = [];
  attachNativeTextInput({ input, commitText: (text, options) => committed.push({ text, options }) });

  input.value = "Ab!";
  emit(input, "input", { inputType: "insertText", data: "Ab!", isComposing: false });
  input.value = "🙂中文\n第二行";
  emit(input, "input", { inputType: "insertFromPaste", data: null, isComposing: false });

  assert.deepEqual(committed, [
    { text: "Ab!", options: { paste: false } },
    { text: "🙂中文\n第二行", options: { paste: true } },
  ]);
  assert.equal(input.value, "");
});

test("普通工作区粘贴会覆盖旧选区并且只提交当次剪贴板文本", () => {
  const input = new FakeInput();
  const committed = [];
  const nativeInput = attachNativeTextInput({ input, commitText: (text, options) => committed.push({ text, options }) });
  nativeInput.setSelectionText("上一次复制的内容");

  input.value = "当次本机剪贴板内容";
  emit(input, "input", { inputType: "insertFromPaste", data: null, isComposing: false });

  assert.deepEqual(committed, [
    { text: "当次本机剪贴板内容", options: { paste: true } },
  ]);
  assert.equal(input.value, "");
});

test("管理员粘贴先同步当次剪贴板再发送一次远端 Ctrl+V", () => {
  class FakeKeyboardEvent extends Event {
    constructor(type, values = {}) {
      super(type, { bubbles: values.bubbles });
      for (const [key, value] of Object.entries(values)) {
        if (key !== "bubbles") Object.defineProperty(this, key, { value });
      }
    }
  }
  const keyboardInput = new EventTarget();
  const clipboardInput = new EventTarget();
  clipboardInput.value = "旧的远程剪贴板";
  const document = {
    querySelector(selector) {
      return selector === "#noVNC_keyboardinput" ? keyboardInput : clipboardInput;
    },
  };
  const sequence = [];
  clipboardInput.addEventListener("change", () => sequence.push(`clipboard:${clipboardInput.value}`));
  installAdministratorPaste(document, Event, FakeKeyboardEvent);
  keyboardInput.addEventListener("keydown", (event) => sequence.push(`down:${event.code}`));
  keyboardInput.addEventListener("keyup", (event) => sequence.push(`up:${event.code}`));

  const shortcut = new FakeKeyboardEvent("keydown", { key: "v", code: "KeyV", metaKey: true });
  keyboardInput.dispatchEvent(shortcut);
  assert.deepEqual(sequence, []);

  const paste = new Event("paste", { cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: (type) => type === "text/plain" ? "当次本机剪贴板" : "" },
  });
  keyboardInput.dispatchEvent(paste);

  assert.equal(paste.defaultPrevented, true);
  assert.deepEqual(sequence, [
    "clipboard:当次本机剪贴板",
    "down:ControlLeft",
    "down:KeyV",
    "up:KeyV",
    "up:ControlLeft",
  ]);
});

test("远端选区映射到本机隐藏输入框供原生复制与剪切", () => {
  const input = new FakeInput();
  const nativeInput = attachNativeTextInput({ input, commitText() {} });

  nativeInput.setSelectionText("远端选中的文本");

  assert.equal(input.value, "远端选中的文本");
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, input.value.length);
  assert.equal(input.focused, true);
  nativeInput.blur();
  assert.equal(input.focused, false);
});

test("远端 Chromium 剪贴板通过当前本机输入框执行原生复制", () => {
  const input = new FakeInput();
  const previous = { focusOptions: null, focus(options) { this.focusOptions = options; } };
  input.ownerDocument.activeElement = previous;
  input.value = "原输入";
  input.setSelectionRange(1, 2);
  const nativeInput = attachNativeTextInput({ input, commitText() {} });

  assert.equal(nativeInput.copyClipboardText("ChatGPT 原生复制内容"), true);
  assert.equal(input.focusedDuringCommand, true);
  assert.equal(input.value, "");
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 0);
  assert.equal(input.executedCommand, "copy");
  assert.deepEqual(previous.focusOptions, { preventScroll: true });
});

test("组合输入只在本机输入法最终确认时提交一次", () => {
  const input = new FakeInput();
  const committed = [];
  attachNativeTextInput({ input, commitText: (text) => committed.push(text) });

  emit(input, "compositionstart", { data: "" });
  input.value = "ni";
  emit(input, "input", { inputType: "insertCompositionText", data: "ni", isComposing: true });
  input.value = "你好呀";
  emit(input, "input", { inputType: "insertCompositionText", data: "你好呀", isComposing: true });
  emit(input, "compositionend", { data: "你好呀" });

  assert.deepEqual(committed, ["你好呀"]);
  assert.equal(input.value, "");
});

test("两个页面的本机组合输入状态互不影响", () => {
  const left = new FakeInput();
  const right = new FakeInput();
  const leftCommitted = [];
  const rightCommitted = [];
  attachNativeTextInput({ input: left, commitText: (text) => leftCommitted.push(text) });
  attachNativeTextInput({ input: right, commitText: (text) => rightCommitted.push(text) });

  emit(left, "compositionstart");
  left.value = "实验室";
  emit(left, "input", { inputType: "insertCompositionText", isComposing: true });
  right.value = "office";
  emit(right, "input", { inputType: "insertText", isComposing: false });
  emit(left, "compositionend", { data: "实验室" });

  assert.deepEqual(leftCommitted, ["实验室"]);
  assert.deepEqual(rightCommitted, ["office"]);
});

test("可打印文本留给本机输入法，其余按键才转发远端", () => {
  const forward = (values) => shouldForwardKey({ getModifierState: () => false, ...values });
  assert.equal(forward({ key: "a", code: "KeyA" }), false);
  assert.equal(forward({ key: "å", code: "KeyA", altKey: true }), false);
  assert.equal(forward({ key: "Process", keyCode: 229, isComposing: true }), false);
  assert.equal(forward({ key: "v", code: "KeyV", metaKey: true }), false);
  assert.equal(forward({ key: "c", code: "KeyC", metaKey: true }), false);
  assert.equal(forward({ key: "x", code: "KeyX", ctrlKey: true }), false);
  assert.equal(forward({ key: " ", code: "Space", ctrlKey: true }), false);
  assert.equal(forward({ key: "Shift", code: "ShiftLeft", shiftKey: true }), false);
  assert.equal(forward({ key: "Enter", code: "Enter", shiftKey: true }), true);
  assert.equal(forward({ key: "a", code: "KeyA", metaKey: true }), true);
  assert.equal(forward({ key: "Backspace", code: "Backspace" }), true);
  assert.equal(
    shouldForwardKey({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true, getModifierState: (name) => name === "AltGraph" }),
    false,
  );
});

test("macOS Command 快捷键按远端 Control 发送", () => {
  assert.equal(remoteModifiers({ metaKey: true }, true), 2);
  assert.equal(remoteModifiers({ ctrlKey: true }, true), 2);
  assert.equal(remoteModifiers({ ctrlKey: true }, false), 2);
  assert.equal(remoteModifiers({ metaKey: true }, false), 4);
  assert.equal(remoteModifiers({ metaKey: true, altKey: true, shiftKey: true }, true), 11);
});
