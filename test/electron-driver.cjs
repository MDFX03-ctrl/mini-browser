'use strict';
// Main-process inspector only: a browser debugger can suspend service workers
// in Electron partitions outside its default browser context.
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');

async function waitUntil(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function launch({ executablePath, cwd, env, args = [] }) {
  // This is a visible GUI test, not a console helper. SW_HIDE in the startup
  // flags can suppress Electron's first show() and stall fullscreen rendering.
  // Another desktop window covering this GUI test must not suspend Chromium's
  // compositor while it acknowledges an HTML fullscreen transition.
  const child = spawn(executablePath, ['--inspect=0', '--disable-features=CalculateNativeWinOcclusion', ...args], { cwd, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  let endpoint;
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    endpoint = stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
  });
  await waitUntil(() => {
    if (child.exitCode !== null) throw new Error(stderr);
    return endpoint;
  }, 'main-process inspector');
  const socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Test inspector closed'));
    }
    pending.clear();
  });
  function command(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(callback, value) {
    const expression = `(${callback.toString()})(process.mainModule.require('electron'), ${JSON.stringify(value) ?? 'undefined'})`;
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  function windowShell(id, overlay = false) {
    const shellEvaluate = (callback, value) => evaluate(({ BrowserWindow }, { id, source, value, overlay }) => {
      const win = BrowserWindow.fromId(id);
      const content = overlay ? win.contentView.children.find(view => view.browserChrome).webContents : win.webContents;
      return content.executeJavaScript(`(${source})(${JSON.stringify(value) ?? 'undefined'})`, true);
    }, { id, source: callback.toString(), value, overlay });
    const shell = {
      id, evaluate: shellEvaluate, overlay: () => windowShell(id, true),
      waitForURL: (url) => waitUntil(() => evaluate(({ BrowserWindow }, {id, url}) => BrowserWindow.fromId(id)?.webContents.getURL() === url, {id, url}), 'shell URL'),
      screenshot: async ({ path }) => {
        await shellEvaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const png = await evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), id);
        fs.writeFileSync(path, Buffer.from(png, 'base64'));
      },
      locator: (selector) => ({
        click: () => shellEvaluate((selector) => {
          const element = document.querySelector(selector);
          if (!element || element.disabled || element.closest('[hidden]')) throw new Error(`Control unavailable: ${selector}`);
          element.click();
        }, selector),
        fill: (value) => shellEvaluate(({ selector, value }) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Input missing: ${selector}`);
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }, { selector, value }),
        waitFor: ({ state }) => waitUntil(() => shellEvaluate(({ selector, state }) => {
          const element = document.querySelector(selector);
          const visible = element && !element.closest('[hidden]');
          return state === 'hidden' ? !visible : visible;
        }, { selector, state }), selector)
      })
    };
    return shell;
  }
  await waitUntil(() => evaluate(({ app, BrowserWindow }) => app.isReady() && BrowserWindow.getAllWindows().length === 1), 'app ready');
  const initialId = await evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  return {
    evaluate, window: windowShell, firstWindow: async () => windowShell(initialId), process: () => child,
    close: async () => {
      if (child.exitCode !== null) { socket.close(); return; }
      // Disconnect while the event loop still runs. Quitting first can leave Node
      // waiting for its inspector while the WebSocket waits for a close handshake.
      await evaluate(({ app }) => { setTimeout(() => app.quit(), 250); });
      socket.close();
      await exited;
    }
  };
}
module.exports = { launch };
