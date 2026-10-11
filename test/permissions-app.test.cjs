'use strict';
const electron = require('./electron-driver.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.realpathSync(process.argv[2] || path.join(root, '.cache', 'test-app', 'Mini Browser.exe'));
assert.ok(source.startsWith(root + path.sep));
const fixture = path.join(root, '.cache', `access-${randomUUID().slice(0,8)}`), temp = path.join(root,'.cache','tmp');
fs.mkdirSync(temp,{recursive:true});
fs.cpSync(path.dirname(source),fixture,{recursive:true,filter:file => {
  const relative=path.relative(path.dirname(source),file);
  return relative.split(path.sep)[0] !== '.mini-browser' && relative !== path.join('resources','installed.flag');
}});
const data = path.join(fixture,'.mini-browser');
const results = path.join(root,'test-results'); fs.mkdirSync(results,{recursive:true});
const png = fs.readFileSync(path.join(root,'assets','icon.png'));
const ico = fs.readFileSync(path.join(root,'assets','icon.ico'));
let iconRequests = 0, application, shell;
const server = http.createServer((req,res) => {
  if(req.url === '/brand.png') {iconRequests++; res.setHeader('Content-Type','image/png'); return res.end(png);}
  if(req.url === '/favicon.ico') {res.setHeader('Content-Type','image/x-icon'); return res.end(ico);}
  if(req.url === '/download') {res.setHeader('Content-Disposition','attachment; filename="blocked.txt"'); return res.end('blocked');}
  res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Permissions fixture</title><link rel="icon" href="/brand.png"><h1>Permissions fixture</h1><input id="note">');
});
async function poll(check,label,timeout=20000) { const start=Date.now(); while(Date.now()-start<timeout) {if(await check())return;await new Promise(r=>setTimeout(r,100));} throw new Error('Timed out: '+label); }
const state=()=>shell.evaluate(()=>window.miniBrowser.getState());
const call=async(method,...args)=>{const before=await state();const result=await shell.evaluate(({method,args})=>window.miniBrowser[method](...args),{method,args});if(method==='newTab')await poll(async()=>(await state()).activeTabId!==before.activeTabId,'new tab publishes');return result;};
async function remote(code,gesture=false) {
  const current=await state(); const index=current.tabs.findIndex(t=>t.id===current.activeTabId);
  return application.evaluate(({BrowserWindow},{id,index,code,gesture})=>BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome)[index].webContents.executeJavaScript(code,gesture),{id:shell.id,index,code,gesture});
}
async function launch(test=false,uuid) {
  const env={...process.env,MINI_BROWSER_TEST:test?'1':'0',TEMP:temp,TMP:temp}; if(uuid)env.MINI_BROWSER_TEST_PROFILE=uuid;
  delete env.ELECTRON_RUN_AS_NODE;
  application=await electron.launch({executablePath:path.join(fixture,'Mini Browser.exe'),cwd:root,env,args:['--use-fake-device-for-media-stream']});
  shell=await application.firstWindow();await shell.waitForURL('mini://app/index.html');await poll(async()=>!!(await state()).activeProfile,'shell ready');
  const downloadDirectory=path.join(fixture,'downloads');fs.mkdirSync(downloadDirectory,{recursive:true});
  await application.evaluate(({app},directory)=>app.setPath('downloads',directory),downloadDirectory);
}
async function navigate(url) {assert.equal((await call('navigate',url)).ok,true);await poll(async()=>{const s=await state();return s.url===url&&!s.loading&&s.mode==='page';},'page loaded');}
async function media(constraints) {
  await remote(`window.mediaResult='pending'; navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)}).then(stream=>{window.testStream=stream;window.mediaResult=stream.getTracks().map(t=>t.kind).sort().join(',');}).catch(e=>window.mediaResult=e.name); 'started'`);
}
async function prompt(labels) {await poll(async()=>JSON.stringify((await state()).permissionPrompt?.labels)===JSON.stringify(labels),'permission prompt');assert.deepEqual((await state()).permissionPrompt.labels,labels);}
async function finishMedia(result) {await poll(async()=>await remote('window.mediaResult')===result,'media result '+result);}
async function run() {
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`;
  try {
    await launch();await navigate(base+'/');
    assert.equal(await remote('typeof window.miniBrowser'),'undefined');
    await media({audio:true}); await prompt(['Microphone']);
    await poll(()=>shell.evaluate(()=>document.querySelector('#access-panel').getBoundingClientRect().height>0),'prompt layout');
    await poll(()=>application.evaluate(({BrowserWindow},id)=>{const win=BrowserWindow.fromId(id);return win.contentView.children.filter(view => !view.browserChrome)[0].getBounds().y>116&&win.contentView.children.filter(view => !view.browserChrome)[0].getVisible();},shell.id),'prompt pushes page down');
    await shell.screenshot({path:path.join(results,'microphone-permission.png')});
    await shell.locator('#permission-allow').click(); await finishMedia('audio');
    await poll(async()=>(await state()).permissionPrompt===null,'permission panel closes');
    await remote('window.testStream.getTracks().forEach(t=>t.stop())');
    await media({audio:true});await finishMedia('audio');await poll(async()=>(await state()).permissionPrompt===null,'permission panel closes');
    await remote('window.testStream.getTracks().forEach(t=>t.stop())');
    await media({video:true});await prompt(['Camera']);await shell.locator('#permission-block').click();await finishMedia('NotAllowedError');
    await media({video:true});await finishMedia('NotAllowedError');await poll(async()=>(await state()).permissionPrompt===null,'permission panel closes');
    console.log('PASS: fake microphone captures after consent, stays allowed on repeat; camera is independent and remembered when blocked');
    await shell.locator('#site-permissions').click();await poll(async()=>(await state()).sitePanelOpen,'site settings');
    assert.equal(await shell.evaluate(()=>document.querySelector('[data-permission="microphone"]').value),'allow');
    assert.equal((await call('updatePermission','set',base,'camera','ask')).ok,true);
    await poll(async()=>!(await state()).loading,'settings reload');await media({video:true});await prompt(['Camera']);await shell.locator('#permission-allow').click();await finishMedia('video');
    await remote('window.testStream.getTracks().forEach(t=>t.stop())');
    await media({audio:true,video:true});await finishMedia('audio,video');
    assert.equal((await call('updatePermission','reset')).ok,true);await poll(async()=>!(await state()).loading&&await remote('typeof window.testStream')==='undefined','reset reload stops capture');
    await media({audio:true,video:true});await prompt(['Microphone','Camera']);await shell.locator('#permission-dismiss').click();await finishMedia('NotAllowedError');
    await media({audio:true});await prompt(['Microphone']);const stale=(await state()).permissionPrompt.id;
    await call('newTab');assert.equal((await call('respondPermission',stale,'allow')).ok,false);
    await navigate(base+'/');await media({audio:true});await prompt(['Microphone']);await shell.locator('#permission-allow').click();await finishMedia('audio');
    await remote('window.testStream.getTracks().forEach(t=>t.stop())');
    console.log('PASS: globe settings/reset reloads pages and stops streams; dismiss and tab changes never save a grant');
    await remote("window.notificationResult='pending';Notification.requestPermission().then(v=>window.notificationResult=v);'started'",true);await prompt(['Notifications']);await shell.locator('#permission-allow').click();await poll(async()=>await remote('window.notificationResult')==='granted','notification consent');
    await remote("window.locationResult='pending';navigator.geolocation.getCurrentPosition(()=>window.locationResult='allowed',e=>window.locationResult=e.code);'started'");await prompt(['Location']);await shell.locator('#permission-block').click();await poll(async()=>await remote('window.locationResult')===1,'location denied');
    // No desktop is captured: replace native enumeration with one controlled fixture.
    await application.evaluate(({desktopCapturer,nativeImage})=>{
      desktopCapturer.getSources=async()=>[{id:'window:fixture:0',name:'Test window',thumbnail:nativeImage.createEmpty()}];
    });
    await new Promise(r=>setTimeout(r,5500));
    await remote("window.shareResult='pending';navigator.mediaDevices.getDisplayMedia({video:true}).then(s=>{s.getTracks().forEach(t=>t.stop());window.shareResult='allowed';}).catch(e=>window.shareResult=e.name);'started'",false);
    await poll(async()=>await remote('window.shareResult')!=='pending','gestureless screen sharing denied');await poll(async()=>(await state()).permissionPrompt===null,'permission panel closes');
    await application.evaluate(({BrowserWindow},id)=>{const win=BrowserWindow.fromId(id);win.show();win.focus();win.contentView.children.filter(view => !view.browserChrome).at(-1).webContents.focus();},shell.id);
    await remote("window.shareResult='pending';navigator.mediaDevices.getDisplayMedia({video:true,audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());window.shareResult='allowed';}).catch(e=>window.shareResult=e.name);'started'",true);
    await poll(async()=>{const s=await state();if(s.permissionPrompt?.kind==='screen')return true;const result=await remote('window.shareResult');if(result!=='pending')throw new Error('Screen share failed before picker: '+result);return false;},'screen source picker');
    assert.equal((await state()).permissionPrompt.sources[0].name,'Test window');await shell.locator('#permission-dismiss').click();await poll(async()=>await remote('window.shareResult')!=='pending','screen share cancellation');assert.notEqual(await remote('window.shareResult'),'allowed');
    console.log('PASS: notification/location choices and explicit screen sharing picker; no screen capture without selection or user gesture');
    await call('bookmark');await poll(async()=>(await state()).bookmarks.some(b=>b.url===base+'/'&&b.icon?.startsWith('data:image/png;base64,')),'official site icon saved');
    await call('addBookmark',base+'/manual','Manually added site');
    await poll(async()=>(await state()).bookmarks.some(b=>b.url===base+'/manual'&&b.icon?.startsWith('data:image/png;base64,')),'standard ICO favicon saved');
    await media({audio:true});await finishMedia('audio');
    await call('home');await poll(()=>application.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id).contentView.children.filter(view => !view.browserChrome).at(-1).webContents.getURL()==='about:blank',shell.id),'home leaves the site');
    assert.equal(await remote('typeof window.testStream'),'undefined');
    await poll(()=>shell.evaluate(()=>!!document.querySelector('.bookmark-monogram img')?.complete),'bookmark icon displayed');
    await shell.screenshot({path:path.join(results,'official-bookmark-icons.png')});
    const before=iconRequests;await new Promise(r=>setTimeout(r,300));assert.equal(iconRequests,before,'start screen uses local icon');
    const pos=await shell.evaluate(()=>({tab:document.querySelector('.tab-card:last-child').getBoundingClientRect().right,plus:document.querySelector('#new-tab').getBoundingClientRect().left}));assert.ok(pos.plus>=pos.tab&&pos.plus-pos.tab<10);
    const original=shell;await call('createProfile','Other');await poll(()=>application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').length===2),'second profile');
    const ids=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').map(w=>w.id));shell=application.window(ids.find(id=>id!==original.id));await shell.waitForURL('mini://app/index.html');await navigate(base+'/');
    await media({audio:true});await prompt(['Microphone']);await shell.locator('#permission-block').click();await finishMedia('NotAllowedError');
    const other=(await state()).activeProfile.id;
    await application.close(); application=null;await launch();assert.equal((await state()).activeProfile.id,other);await navigate(base+'/');await media({audio:true});await finishMedia('NotAllowedError');await poll(async()=>(await state()).permissionPrompt===null,'permission panel closes');
    await call('switchProfile','default');await poll(()=>application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').length===2),'default reopened');
    const restarted=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').map(w=>w.id));shell=application.window(restarted.find(id=>id!==shell.id));await shell.waitForURL('mini://app/index.html');await navigate(base+'/');await media({audio:true});await finishMedia('audio');await poll(async()=>(await state()).permissionPrompt===null,'permission panel closes');await remote('window.testStream.getTracks().forEach(t=>t.stop())');
    assert.ok((await state()).bookmarks[0].icon);await remote("location.href='/download'");await poll(async()=>(await state()).downloads.some(item=>item.state==='completed'),'download completes');await call('downloadsPanel',false);
    for(const value of ['file:///C:/Windows','javascript:alert(1)','mini://app/index.html'])assert.equal((await call('navigate',value)).ok,false);
    assert.ok(fs.existsSync(path.join(data,'permissions.json')));assert.ok(fs.existsSync(path.join(data,'profiles',other,'permissions.json')));
    console.log('PASS: icons, + follows last tab, profile-specific permission choices and restart persistence; downloads work and navigation restrictions remain');
    await application.close();application=null;
    const uuid=randomUUID(), testData=path.join(data,'tests',uuid);fs.mkdirSync(testData,{recursive:true});
    fs.writeFileSync(path.join(testData,'profiles.json'),'keep profiles');fs.writeFileSync(path.join(testData,'permissions.json'),'keep permissions');
    await launch(true,uuid);assert.equal((await state()).activeProfile.id,'default');await navigate(base+'/');await media({audio:true});await prompt(['Microphone']);await shell.locator('#permission-allow').click();await finishMedia('audio');
    await application.close();application=null;
    assert.equal(fs.readFileSync(path.join(testData,'profiles.json'),'utf8'),'keep profiles');assert.equal(fs.readFileSync(path.join(testData,'permissions.json'),'utf8'),'keep permissions');
    console.log('PASS: MINI_BROWSER_TEST keeps grants in memory and never reads or overwrites profile/permission files');
  } finally {if(application)await application.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
