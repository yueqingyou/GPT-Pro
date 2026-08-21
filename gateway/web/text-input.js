const MODIFIER_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Meta",
  "NumLock",
  "ScrollLock",
  "Shift",
]);

export function shouldForwardKey(event) {
  const key = String(event.key || "");
  if (event.isComposing || event.keyCode === 229 || key === "Process" || key === "Dead") return false;
  if (MODIFIER_KEYS.has(key)) return false;
  if ((event.ctrlKey || event.metaKey) && ["c", "v", "x"].includes(key.toLocaleLowerCase("en-US"))) return false;
  if (key === " " && (event.ctrlKey || event.metaKey)) return false;
  const altGraph = event.getModifierState("AltGraph");
  return !(key.length === 1 && ((!event.ctrlKey && !event.metaKey) || altGraph));
}

export function remoteModifiers(event, macOS) {
  const control = event.ctrlKey || (macOS && event.metaKey);
  const meta = !macOS && event.metaKey;
  return (event.altKey ? 1 : 0) | (control ? 2 : 0) | (meta ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

export function attachNativeTextInput({ input, commitText }) {
  let composing = false;

  const clear = () => {
    input.value = "";
    input.setSelectionRange(0, 0);
  };
  const focus = () => {
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  };
  const blur = () => input.blur();
  const setSelectionText = (text) => {
    if (composing) return false;
    input.value = String(text || "");
    if (input.value) input.focus({ preventScroll: true });
    input.setSelectionRange(0, input.value.length);
    return true;
  };
  const copyClipboardText = (text) => {
    if (composing) return false;
    const document = input.ownerDocument;
    const active = document.activeElement;
    const value = input.value;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = String(text || "");
    input.focus({ preventScroll: true });
    input.setSelectionRange(0, input.value.length);
    const copied = document.execCommand("copy");
    input.value = value;
    input.setSelectionRange(start, end);
    if (active !== input) {
      input.blur();
      active?.focus?.({ preventScroll: true });
    }
    return copied;
  };
  const onCompositionStart = () => {
    composing = true;
    clear();
  };
  const onCompositionEnd = (event) => {
    composing = false;
    const text = String(event.data || "");
    clear();
    if (text) commitText(text);
  };
  const onInput = (event) => {
    if (composing || event.isComposing) return;
    const text = String(input.value || "");
    clear();
    if (text) commitText(text);
  };

  clear();
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("input", onInput);

  return { focus, blur, setSelectionText, copyClipboardText };
}
