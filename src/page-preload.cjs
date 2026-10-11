'use strict';
// Sandboxed, isolated DOM observer. No Node or application API is exposed to pages.
const { ipcRenderer } = require('electron');
let submitted = false, queued = false, last = '';
const visible = input => input.getClientRects().length > 0 && !input.disabled;
function fields(root = document) {
  const password = [...root.querySelectorAll('input[type="password"]')].find(visible);
  const form = password?.form || document;
  const username = [...form.querySelectorAll('input')].find(input => visible(input) && (input.autocomplete === 'username' || input.type === 'email'))
    || [...form.querySelectorAll('input[type="text"],input:not([type])')].find(visible);
  return { password, username };
}
function report() {
  queued = false;
  const { password } = fields();
  const failed = [...document.querySelectorAll('[role="alert"],.error,.error-message,[aria-invalid="true"]')]
    .some(node => node.getClientRects().length && /incorrect|invalid|failed|wrong|denied|error/i.test(node.textContent || ''));
  const value = JSON.stringify([!!password, failed]);
  if (value !== last || submitted) { last = value; ipcRenderer.send('browser:login-page', { hasPassword: !!password, failed }); }
  if (!password) submitted = false;
}
window.addEventListener('DOMContentLoaded', () => {
  report();
  new MutationObserver(() => { if (!queued) { queued = true; setTimeout(report, 200); } }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
});
document.addEventListener('submit', event => {
  const form = event.target;
  const passwords = [...form.querySelectorAll('input[type="password"]')].filter(visible);
  if (passwords.length !== 1 || passwords[0].autocomplete === 'new-password' || !passwords[0].value) return;
  const { username } = fields(form);
  submitted = true;
  ipcRenderer.send('browser:login-submit', { username: username?.value || '', password: passwords[0].value });
  setTimeout(report, 300);
}, true);
document.addEventListener('pointerdown', () => ipcRenderer.send('browser:page-activity'), true);
ipcRenderer.on('browser:login-fill', (_event, login) => {
  if (location.origin !== login.origin) return;
  const { password, username } = fields(); if (!password || password.autocomplete === 'new-password') return;
  const set = (input, value) => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set(username, login.username); set(password, login.password); password.focus();
});
