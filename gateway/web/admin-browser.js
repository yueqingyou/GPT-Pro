export function installAdministratorPaste(documentRef, EventCtor, KeyboardEventCtor) {
  const keyboardInput = documentRef.querySelector("#noVNC_keyboardinput");
  const clipboardInput = documentRef.querySelector("#noVNC_clipboard_text");
  let forwarding = false;

  keyboardInput.addEventListener("keydown", (event) => {
    if (
      !forwarding &&
      !event.altKey &&
      (event.ctrlKey || event.metaKey) &&
      String(event.key || "").toLocaleLowerCase("en-US") === "v"
    ) {
      event.stopImmediatePropagation();
    }
  }, true);

  keyboardInput.addEventListener("paste", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = String(event.clipboardData?.getData("text/plain") || "");
    if (!text) return;
    clipboardInput.value = text;
    clipboardInput.dispatchEvent(new EventCtor("change", { bubbles: true }));
    forwarding = true;
    for (const [type, values] of [
      ["keydown", { key: "Control", code: "ControlLeft", ctrlKey: true }],
      ["keydown", { key: "v", code: "KeyV", ctrlKey: true }],
      ["keyup", { key: "v", code: "KeyV", ctrlKey: true }],
      ["keyup", { key: "Control", code: "ControlLeft" }],
    ]) {
      keyboardInput.dispatchEvent(new KeyboardEventCtor(type, { ...values, bubbles: true }));
    }
    forwarding = false;
  }, true);
}

export function installAdministratorBrowser(environment = globalThis) {
  const { document, Event, KeyboardEvent, MutationObserver } = environment;
  document.title = "GPT Pro";
  const title = document.querySelector("title");
  new MutationObserver(() => {
    if (document.title !== "GPT Pro") document.title = "GPT Pro";
  }).observe(title, { childList: true, characterData: true, subtree: true });

  const ime = document.querySelector("#noVNC_setting_enable_ime");
  const keyboardInput = document.querySelector("#noVNC_keyboardinput");
  installAdministratorPaste(document, Event, KeyboardEvent);
  ime.closest("label").hidden = true;
  const positionCaret = () => keyboardInput.setSelectionRange(keyboardInput.value.length, keyboardInput.value.length);
  keyboardInput.addEventListener("focus", positionCaret);

  const enableIme = () => {
    if (!document.documentElement.classList.contains("noVNC_connected")) return;
    ime.checked = true;
    ime.dispatchEvent(new Event("change", { bubbles: true }));
    positionCaret();
    connectionObserver.disconnect();
  };
  const connectionObserver = new MutationObserver(enableIme);
  connectionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  enableIme();
}

if (globalThis.document) installAdministratorBrowser();
