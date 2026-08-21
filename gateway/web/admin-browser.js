document.title = "GPT Pro";
const title = document.querySelector("title");
new MutationObserver(() => {
  if (document.title !== "GPT Pro") document.title = "GPT Pro";
}).observe(title, { childList: true, characterData: true, subtree: true });

const ime = document.querySelector("#noVNC_setting_enable_ime");
const keyboardInput = document.querySelector("#noVNC_keyboardinput");
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
