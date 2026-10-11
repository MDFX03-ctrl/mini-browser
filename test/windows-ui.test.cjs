'use strict';
require('../scripts/test-runtime.cjs');
const { _electron: electron } = require('playwright-core');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const executablePath = fs.realpathSync(process.argv[2] || path.join(root, '.cache', 'test-app', 'Mini Browser.exe'));
assert.ok(executablePath.startsWith(root + path.sep));
const temp = path.join(root, '.cache', 'tmp'); fs.mkdirSync(temp, { recursive: true });
const env = { ...process.env, MINI_BROWSER_TEST: '1', MINI_BROWSER_TEST_PROFILE: randomUUID(), TEMP: temp, TMP: temp };
delete env.ELECTRON_RUN_AS_NODE;
async function run() {
  const application = await electron.launch({ executablePath, cwd: root, env });
  try {
    await application.firstWindow();
    for (let attempts = 0; !application.windows().some(page => page.url() === 'mini://app/index.html'); attempts++) { if (attempts > 200) throw new Error('Shell did not load'); await new Promise(resolve => setTimeout(resolve, 100)); }
    const shell = application.windows().find(page => page.url() === 'mini://app/index.html');
    await shell.waitForURL('mini://app/index.html');
    const originalId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() !== 'mini://icon-decoder/').id);
    await application.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id).show(); BrowserWindow.fromId(id).focus(); }, originalId);
    await shell.evaluate(() => window.miniBrowser.createProfile('Work'));
    await application.evaluate(({ BrowserWindow }, id) => { const win=BrowserWindow.fromId(id);win.show();win.focus(); }, originalId);
    await shell.locator('#profile-toggle').click();
    let picker;
    for (const page of application.windows().filter(page => page.url() === 'mini://app/index.html?overlay=1')) {
      if ((await page.evaluate(()=>window.miniBrowser.getState())).activeProfile.id === 'default') { picker=page;break; }
    }
    assert.ok(picker,'use the overlay belonging to the original window');
    await picker.locator('#profile-panel').waitFor({state:'visible'});
    const rows = await picker.locator('.profile-card').evaluateAll(nodes => nodes.map(node => {const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};}));
    assert.equal(rows[0].x,rows[1].x);assert.equal(rows[0].width,rows[1].width);assert.ok(rows[1].y>rows[0].y);
    const keys = await shell.evaluate(() => window.miniBrowser.getState().then(s => s.profiles.map(p => p.id)));
    await picker.locator('.profile-card .reorder-handle').first().dragTo(picker.locator('.profile-card').last());
    await shell.waitForFunction(expected => window.miniBrowser.getState().then(s => JSON.stringify(s.profiles.map(p => p.id)) === JSON.stringify(expected)), [...keys].reverse());
    const choosing = picker.waitForEvent('filechooser');
    await picker.locator('.profile-card[data-id="default"] .profile-picture').click();
    await (await choosing).setFiles(path.join(root,'assets','icon.png'));
    await shell.waitForFunction(()=>!!document.querySelector('#profile-toggle img')?.naturalWidth);
    const photo = await shell.evaluate(()=>window.miniBrowser.getState().then(s=>s.activeProfile.picture));
    assert.ok(photo.startsWith('data:image/png;base64,'));
    assert.equal(await shell.evaluate(()=>window.miniBrowser.getState().then(s=>s.profiles.find(p=>p.id!=='default').picture)),undefined);
    assert.equal(await picker.locator('.profile-card[data-id="default"] .profile-picture img').evaluate(img=>img.naturalWidth),128);
    const portraitPreview = await application.evaluate(async ({BrowserWindow}, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), originalId);
    fs.writeFileSync(path.join(root,'.cache','profile-picture.png'),Buffer.from(portraitPreview,'base64'));
    await picker.screenshot({path:path.join(root,'.cache','profile-picker.png')});
    await picker.locator('.profile-card[data-id="default"] .profile-picture-remove').click();
    await shell.waitForFunction(()=>!document.querySelector('#profile-toggle img'));
    console.log('PASS: local profile-picture upload, cropped preview, profile separation and removal');
    await picker.locator('#profile-close').click();
    await shell.evaluate(async () => {
      await window.miniBrowser.addBookmark('https://a.example/', 'A');
      await window.miniBrowser.addBookmark('https://b.example/', 'B');
    });
    await shell.locator('#bookmarks-list .bookmark-card .reorder-handle').first().dragTo(shell.locator('#bookmarks-list .bookmark-card').last());
    await shell.waitForFunction(() => window.miniBrowser.getState().then(s => s.bookmarks[0].title === 'B'));
    console.log('PASS: real drag gestures reorder profile cards and bookmarks');
    await shell.locator('#bookmarks-list .bookmark-card .bookmark-open').first().click({button:'right'});
    await picker.locator('#bookmark-edit-open').click();
    await picker.locator('#bookmark-edit-name').fill('Edited B');
    await picker.locator('#bookmark-edit-url').fill('javascript:alert(1)');
    await picker.locator('#bookmark-edit-form button.primary-button').click();
    await picker.locator('#bookmark-edit-error').waitFor({state:'visible'});
    assert.equal((await shell.evaluate(()=>window.miniBrowser.getState())).bookmarks[0].url,'https://b.example/');
    await picker.locator('#bookmark-edit-url').fill('https://a.example/');
    await picker.locator('#bookmark-edit-form button.primary-button').click();
    await picker.locator('#bookmark-edit-error').waitFor({state:'visible'});
    assert.equal((await shell.evaluate(()=>window.miniBrowser.getState())).bookmarks.length,2);
    await picker.locator('#bookmark-edit-url').fill('https://edited.example/');
    await picker.locator('#bookmark-edit-form button.primary-button').click();
    await picker.locator('#bookmark-edit-form').waitFor({state:'hidden'});
    assert.deepEqual((await shell.evaluate(()=>window.miniBrowser.getState())).bookmarks.map(b=>[b.title,b.url]),[['Edited B','https://edited.example/'],['A','https://a.example/']]);
    await shell.locator('#bookmark-bar .bookmark-open').first().click({button:'right'});
    await picker.locator('#bookmark-edit-open').click();
    assert.equal(await picker.locator('#bookmark-edit-name').inputValue(),'Edited B');
    await picker.locator('#bookmark-edit-form [data-ui="close"]').first().click();
    console.log('PASS: shortcut and bar right-click Edit, changed name/link, stable order and rejection of invalid/duplicate links');
    await shell.evaluate(async () => {
      for (let i = 0; i < 10; i++) await window.miniBrowser.addBookmark(`https://shortcut-${i}.invalid/`, i === 0 ? 'A long bookmark title that should fit neatly in the bar' : `Shortcut ${i + 1}`);
    });
    for (const width of [360, 480, 900]) {
      await application.evaluate(({ BrowserWindow }, { id, width }) => BrowserWindow.fromId(id).setSize(width, 800), { id: originalId, width });
      await shell.waitForFunction(expected => innerWidth === expected, width);
      const layout = await shell.evaluate(() => {
        const cards = [...document.querySelectorAll('#bookmarks-list .bookmark-card')];
        const box = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
        const bar = [...document.querySelectorAll('#bookmark-bar .bookmark-open')].map(node => ({ button:box(node), icon:box(node.querySelector('.bookmark-monogram')), text:box(node.querySelector('strong')) }));
        const section = document.querySelector('.bookmarks-section');
        return { cards:cards.map(box), bar, pageWidth:innerWidth, scrollWidth:section.scrollWidth, clientWidth:section.clientWidth,
          overflowY:getComputedStyle(section).overflowY, pin:box(document.getElementById('pin')), hide:box(document.getElementById('hide-ui')),
          strip:box(document.querySelector('.tab-strip')), inMenu:!!document.querySelector('#app-menu #pin, #app-menu #hide-ui'),
          background:getComputedStyle(document.getElementById('welcome')).backgroundImage };
      });
      assert.equal(layout.cards.length, 12);
      assert.equal(new Set(layout.cards.map(card => Math.round(card.y))).size,1,'shortcuts stay in one horizontal row');
      assert.ok(layout.scrollWidth > layout.clientWidth,'shortcuts scroll horizontally');
      assert.ok(!['auto','scroll'].includes(layout.overflowY), 'no internal shortcut scroll container');
      await shell.locator('#start-address').focus(); await shell.mouse.move(8,8);
      assert.match(await shell.locator('.bookmarks-section').evaluate(node=>getComputedStyle(node).scrollbarColor),/transparent|0, 0, 0, 0/);
      await shell.locator('.bookmarks-section').hover();
      assert.ok((await shell.locator('.bookmarks-section').evaluate(node=>getComputedStyle(node).scrollbarColor)).includes('193, 208, 181'));
      await shell.mouse.wheel(0,200);
      await shell.waitForFunction(()=>document.querySelector('.bookmarks-section').scrollLeft>0);
      await shell.locator('.bookmarks-section').evaluate(node=>{node.scrollLeft=0;});
      for (const {button,icon,text} of layout.bar) {
        assert.equal(icon.width,16); assert.equal(icon.height,16);
        assert.ok(Math.abs(icon.y + icon.height/2 - text.y - text.height/2) < 1, 'letters and labels share a center line');
        assert.ok(text.right <= button.right && button.width <= 170, 'long bookmark labels fit in the bar button');
      }
      for (const control of [layout.pin,layout.hide]) assert.ok(control.width > 0 && control.y >= layout.strip.y && control.bottom <= layout.strip.bottom);
      assert.equal(layout.inMenu,false); assert.ok(layout.background.includes('radial-gradient'));
      if (width === 480) {
        const png = await application.evaluate(async ({BrowserWindow}, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), originalId);
        fs.writeFileSync(path.join(root,'.cache','green-shortcuts.png'),Buffer.from(png,'base64'));
      }
    }
    await application.evaluate(({BrowserWindow,screen},id)=>{const area=screen.getPrimaryDisplay().workArea;const win=BrowserWindow.fromId(id);win.setBounds({x:area.x+20,y:area.y+20,width:480,height:800});win.show();win.focus();},originalId);
    await shell.waitForFunction(()=>innerWidth===480);
    await shell.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await shell.locator('#pin').click();
    await shell.waitForFunction(()=>document.getElementById('pin').getAttribute('aria-pressed')==='true');
    assert.equal(await shell.locator('#pin').getAttribute('aria-pressed'), 'true');
    await shell.locator('#pin').click();
    await shell.waitForFunction(()=>document.getElementById('pin').getAttribute('aria-pressed')==='false');
    await shell.locator('#hide-ui').click();
    await shell.waitForFunction(()=>document.getElementById('hide-ui').getAttribute('aria-pressed')==='true');
    assert.equal((await shell.evaluate(()=>window.miniBrowser.getState())).hideUI,true);
    await shell.locator('#hide-ui').click();
    await shell.waitForFunction(()=>document.getElementById('hide-ui').getAttribute('aria-pressed')==='false');
    console.log('PASS: green theme, aligned bookmark letters, horizontal shortcuts with hover scrollbar and top-strip Pin/Auto-hide at 360/480/900px');
    await shell.locator('#new-tab').click();
    const moving = await shell.evaluate(() => window.miniBrowser.getState().then(s => s.activeTabId));
    const bounds = await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getContentBounds(), originalId);
    const outside = { x: bounds.x - 100, y: bounds.y + bounds.height + 100 };
    await application.evaluate(({ screen }, point) => { screen.getCursorScreenPoint = () => point; }, outside);
    const tab = shell.locator(`.tab-card[data-id="${moving}"] .tab-select`);
    const rect = await tab.boundingBox();
    await shell.mouse.move(rect.x + 15, rect.y + 10);
    await shell.mouse.down();
    await shell.mouse.move(rect.x + 28, rect.y + 10, { steps: 4 });
    await shell.waitForFunction(() => document.body.classList.contains('tab-dragging'));
    await shell.mouse.up();
    await shell.waitForFunction(id => window.miniBrowser.getState().then(s => !s.tabs.some(t => t.id === id)), moving);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').length), 3);
    console.log('PASS: tab pointer capture, drag threshold, and release create a separate same-profile window');
    const data = await application.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(fs.existsSync(path.join(data, 'profiles.json')), false);
  } finally { await application.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
