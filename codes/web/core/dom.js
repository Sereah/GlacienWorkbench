const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

// 空输入框按 Tab 接受 placeholder；再次按 Tab 时恢复正常焦点切换。
document.addEventListener('keydown', event => {
  const input = event.target;
  if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
  if (input.disabled || input.readOnly || input.value || !input.placeholder) return;
  event.preventDefault();
  input.value = input.placeholder;
  input.dispatchEvent(new Event('input', {bubbles: true}));
  input.dispatchEvent(new Event('change', {bubbles: true}));
});

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => element.className = 'toast', 3400);
}

async function copyTextToClipboard(text) {
  const textarea = document.createElement('textarea');
  const previousFocus = document.activeElement;
  textarea.value = String(text);
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try { copied = Boolean(document.execCommand?.('copy')); } catch (error) { copied = false; }
  textarea.remove();
  previousFocus?.focus?.();
  if (copied) return true;
  if (!navigator.clipboard?.writeText) return false;
  try { await navigator.clipboard.writeText(String(text)); return true; } catch (error) { return false; }
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value ?? '';
  return node.innerHTML;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}
