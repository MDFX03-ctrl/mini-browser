'use strict';
const electron = require('./electron-driver.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const executablePath = fs.realpathSync(process.argv[2] || path.join(root, '.cache', 'test-app', 'Mini Browser.exe'));
assert.ok(executablePath.startsWith(root + path.sep));
const temp = path.join(root, '.cache', 'tmp'); fs.mkdirSync(temp, { recursive:true });
const env = { ...process.env, MINI_BROWSER_TEST:'1', MINI_BROWSER_TEST_PROFILE:randomUUID(), TEMP:temp, TMP:temp };
delete env.ELECTRON_RUN_AS_NODE;
let application, shell;
let uploaded = '';
const page = `<!doctype html><html class="sdtrn-root"><head><title>Browser interactions</title>
<style>body{margin:0;font:14px system-ui;background:white}.sdtrn-root .draggable{app-region:drag!important}button,input{font:inherit}header{display:flex;height:64px;gap:20px;align-items:center;padding:12px}#chooser{position:absolute;top:65px;background:white;border:1px solid #ccc;padding:12px}#voice{position:fixed;bottom:20px;left:12px;right:12px;padding:12px;background:#eee}#composer{width:65%;min-height:30px}#sidebar{padding:16px}#frame{width:180px;height:80px}</style></head><body>
<header class="draggable"><button id="sidebar-toggle" class="draggable">Close sidebar</button><button id="switch" class="draggable" aria-expanded="false">ChatGPT / Codex</button></header>
<div id="chooser" hidden role="menu"><button id="codex" role="menuitem">Codex</button></div><aside id="sidebar">Sidebar</aside>
<iframe id="frame" src="/frame"></iframe><input type="file" id="upload">
<section id="voice" class="draggable"><button id="start-call">Start voice</button><form id="message-form"><input id="composer" class="draggable" aria-label="Message"><button id="send" class="draggable">Send</button></form></section>
<script>
window.events=[];window.messages=[];window.hovered=false;
const menu=document.getElementById('chooser'),toggle=document.getElementById('switch');
toggle.addEventListener('mouseenter',()=>window.hovered=true);
toggle.onclick=()=>{menu.hidden=!menu.hidden;toggle.setAttribute('aria-expanded',String(!menu.hidden));};
document.getElementById('codex').onclick=()=>{toggle.textContent='Codex';menu.hidden=true;history.pushState({},'', '/codex');};
document.getElementById('sidebar-toggle').onclick=()=>{document.getElementById('sidebar').hidden=!document.getElementById('sidebar').hidden;};
window.startCall=async()=>{
 window.stream=await navigator.mediaDevices.getUserMedia({audio:true});
 window.sender=new RTCPeerConnection({iceServers:[]});window.receiver=new RTCPeerConnection({iceServers:[]});
 const candidatesA=[],candidatesB=[];
 sender.onicecandidate=({candidate})=>{if(candidate){if(receiver.remoteDescription)receiver.addIceCandidate(candidate);else candidatesA.push(candidate);}};
 receiver.onicecandidate=({candidate})=>{if(candidate){if(sender.remoteDescription)sender.addIceCandidate(candidate);else candidatesB.push(candidate);}};
 stream.getTracks().forEach(track=>sender.addTrack(track,stream));
 receiver.ontrack=({track})=>{window.receivedAudio=track;};
 receiver.ondatachannel=({channel})=>{window.incoming=channel;channel.onmessage=({data})=>messages.push(data);};
 window.channel=sender.createDataChannel('messages');
 await sender.setLocalDescription(await sender.createOffer());await receiver.setRemoteDescription(sender.localDescription);
 await Promise.all(candidatesA.map(candidate=>receiver.addIceCandidate(candidate)));
 await receiver.setLocalDescription(await receiver.createAnswer());await sender.setRemoteDescription(receiver.localDescription);
 await Promise.all(candidatesB.map(candidate=>sender.addIceCandidate(candidate)));
};
document.getElementById('start-call').onclick=()=>startCall().catch(error=>window.callError=error.message);
document.getElementById('message-form').onsubmit=event=>{event.preventDefault();const text=document.getElementById('composer');if(channel.readyState==='open'&&text.value){channel.send(text.value);text.value='';}};
document.getElementById('upload').onchange=async event=>{const body=new FormData();body.append('file',event.target.files[0]);window.uploadResult=await fetch('/upload',{method:'POST',body}).then(response=>response.text());};
addEventListener('blur',()=>events.push('blur'));
</script></body></html>`;
const server = http.createServer((req,res)=>{
 if (req.url === '/favicon.ico') { res.writeHead(404);return res.end(); }
 if (req.url === '/frame') { res.setHeader('Content-Type','text/html');return res.end('<!doctype html><style>html,body{height:100%;margin:0}button{width:100%;height:100%;app-region:drag!important}</style><button id="frame-button" onclick="this.textContent=\'Clicked\'">Frame button</button>'); }
 if (req.url === '/events') { res.setHeader('Content-Type','text/event-stream');res.write('data: first\\n\\n'.replaceAll('\\n','\n'));const timer=setTimeout(()=>res.end('data: second\\n\\n'.replaceAll('\\n','\n')),100);res.on('close',()=>clearTimeout(timer));return; }
 if (req.url === '/upload') { const chunks=[];req.on('data',chunk=>chunks.push(chunk));return req.on('end',()=>{uploaded=Buffer.concat(chunks).toString();res.end('uploaded');}); }
 res.setHeader('Content-Type','text/html');res.end(page);
});
server.on('upgrade',(req,socket)=>{
 const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 let buffer=Buffer.alloc(0);
 socket.on('error',()=>{});
 socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length<6)return;const length=buffer[1]&127;if(length>=126||!(buffer[1]&128)){socket.destroy();return;}if(buffer.length<6+length)return;const opcode=buffer[0]&15;if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}const body=Buffer.from(buffer.subarray(6,6+length));for(let i=0;i<body.length;i++)body[i]^=buffer[2+i%4];if(opcode===1)socket.write(Buffer.concat([Buffer.from([0x81,body.length]),body]));buffer=buffer.subarray(6+length);});
});
async function poll(check,label,timeout=20000) { const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+label); }
const state=()=>shell.evaluate(()=>window.miniBrowser.getState());
async function remote(source) { return application.evaluate(({BrowserWindow},{id,source})=>BrowserWindow.fromId(id).contentView.children.find(view=>!view.browserChrome&&view.getVisible()).webContents.executeJavaScript(source),{id:shell.id,source}); }
async function pageInput(selector,type='click') {
 const point=await remote(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
 await application.evaluate(({BrowserWindow},{id,point,type})=>{
  const content=BrowserWindow.fromId(id).contentView.children.find(view=>!view.browserChrome&&view.getVisible()).webContents;
  content.sendInputEvent({type:'mouseMove',...point});
  if(type==='click'){content.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});content.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});}
 },{id:shell.id,point,type});
}
async function hit(selector,expected=1,windowId=shell.id) {
 if(process.platform!=='win32')return;
 const details=await application.evaluate(async({BrowserWindow},{id,selector})=>{
  const win=BrowserWindow.fromId(id),view=win.contentView.children.find(view=>!view.browserChrome&&view.getVisible()),content=view?.webContents||win.webContents;
  const point=await content.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  return {handle:win.getNativeWindowHandle().readBigUInt64LE().toString(),x:point.x,y:point.y+(view?.getBounds().y||0),width:win.getContentSize()[0]};
 },{id:windowId,selector});
 const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'window-hit-test.ps1'),details.handle,String(details.x),String(details.y),String(details.width)],{cwd:root,env,windowsHide:true,encoding:'utf8'}).trim();
 assert.equal(Number(result),expected,`${selector}: OS hit test must route website input to the page, not the window caption`);
}
async function run() {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  application=await electron.launch({executablePath,cwd:root,env,args:['--use-fake-device-for-media-stream']});shell=await application.firstWindow();await shell.waitForURL('mini://app/index.html');
  await application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/')[0];win.show();win.focus();});
  await shell.evaluate(url=>window.miniBrowser.navigate(url),base+'/');
  await poll(async()=>{const s=await state();return s.mode==='page'&&!s.loading&&s.url===base+'/';},'fixture');
  await hit('#switch'); await hit('#sidebar-toggle'); await hit('#composer');await hit('#send');await hit('#frame');
  await remote('document.getElementById("switch").style.setProperty("app-region","drag","important")');await hit('#switch');
  await pageInput('#switch');await poll(()=>remote('!document.getElementById("chooser").hidden'),'switch menu');
  assert.equal(await remote('hovered'),true);
  await pageInput('#codex');await poll(()=>remote('document.getElementById("switch").textContent === "Codex"'),'switch selection');
  await pageInput('#sidebar-toggle');assert.equal(await remote('document.getElementById("sidebar").hidden'),true);
  console.log('PASS: native Windows hit tests, hover, dropdown selection, sidebar and same-document navigation');
  await pageInput('#start-call');await poll(async()=>!!(await state()).permissionPrompt,'microphone prompt');
  await shell.locator('#permission-allow').click();
  await poll(()=>remote('window.channel?.readyState === "open" && window.receivedAudio?.readyState === "live"'),'voice connection');
  await pageInput('#composer');
  await application.evaluate(async({BrowserWindow},id)=>{const content=BrowserWindow.fromId(id).contentView.children.find(view=>!view.browserChrome&&view.getVisible()).webContents;await content.insertText('Typed during voice');},shell.id);
  const continuity=await application.evaluate(async({BrowserWindow},id)=>{
   const win=BrowserWindow.fromId(id),content=win.contentView.children.find(view=>!view.browserChrome&&view.getVisible()).webContents;
   let reordered=0;const original=win.contentView.addChildView;
   win.contentView.addChildView=function(...args){reordered++;return original.apply(this,args);};
   try{for(let i=0;i<10;i++){content.emit('audio-state-changed');content.emit('page-title-updated',{},'Voice '+i);}
    await new Promise(r=>setTimeout(r,250));return {reordered,focused:content.isFocused(),input:await content.executeJavaScript('document.activeElement.id')};
   }finally{win.contentView.addChildView=original;}
  },shell.id);
  assert.deepEqual(continuity,{reordered:0,focused:true,input:'composer'});
  await pageInput('#send');await poll(()=>remote('messages[0] === "Typed during voice"'),'send typed text during voice');
  await pageInput('#composer');
  await application.evaluate(async({BrowserWindow},id)=>{const content=BrowserWindow.fromId(id).contentView.children.find(view=>!view.browserChrome&&view.getVisible()).webContents;await content.insertText('Enter during voice');content.sendInputEvent({type:'keyDown',keyCode:'Enter'});content.sendInputEvent({type:'char',keyCode:'\r'});content.sendInputEvent({type:'keyUp',keyCode:'Enter'});},shell.id);
  await poll(()=>remote('messages[1] === "Enter during voice"'),'Enter while voice is active');
  assert.equal(await remote('stream.getAudioTracks()[0].readyState'), 'live');
  console.log('PASS: microphone consent and live WebRTC audio/data with typed send and Enter');
  assert.equal(await remote(`new Promise(resolve=>{const chunks=[],recorder=new MediaRecorder(stream,{mimeType:'audio/webm;codecs=opus'});recorder.ondataavailable=event=>chunks.push(event.data);recorder.onstop=()=>resolve(chunks.some(blob=>blob.size>0));recorder.start();setTimeout(()=>recorder.stop(),300);})`),true);
  console.log('PASS: Opus audio recording');
  assert.equal(await remote(`new Promise((resolve,reject)=>{const socket=new WebSocket(${JSON.stringify(base.replace('http:','ws:'))});socket.onopen=()=>socket.send('voice text');socket.onmessage=({data})=>{socket.close();resolve(data);};socket.onerror=()=>reject(new Error('WebSocket failed'));})`),'voice text');
  assert.match(await remote(`fetch('/events').then(response=>response.text())`),/data: first\n\ndata: second/);
  console.log('PASS: real-time WebSocket and streamed responses');
  const upload=await application.evaluate(async({BrowserWindow},{id,file})=>{
   const content=BrowserWindow.fromId(id).contentView.children.find(view=>!view.browserChrome&&view.getVisible()).webContents;
   content.debugger.attach('1.3');
   try{await content.debugger.sendCommand('Page.enable');await content.debugger.sendCommand('Page.setInterceptFileChooserDialog',{enabled:true});
    const opened=new Promise(resolve=>{const listener=(_event,method,params)=>{if(method==='Page.fileChooserOpened'){content.debugger.removeListener('message',listener);resolve(params);}};content.debugger.on('message',listener);});
    await content.executeJavaScript('document.getElementById("upload").click()',true);
    const chooser=await opened;await content.debugger.sendCommand('DOM.setFileInputFiles',{backendNodeId:chooser.backendNodeId,files:[file]});return chooser.mode;
   }finally{content.debugger.detach();}
  },{id:shell.id,file:path.join(root,'test','fixtures','icons','WPT-LICENSE.md')});
  assert.equal(upload,'selectSingle');await poll(()=>remote('window.uploadResult === "uploaded"'),'native selected-file upload');
  assert.match(uploaded,/filename="WPT-LICENSE.md"/);assert.ok(uploaded.includes('Copyright'));
  await remote('window.clipboardResult="pending";navigator.clipboard.readText().then(()=>window.clipboardResult="allowed",error=>window.clipboardResult=error.name);void 0');
  await poll(async()=>!!(await state()).permissionPrompt,'clipboard consent');assert.deepEqual((await state()).permissionPrompt.labels,['Read clipboard']);
  await shell.locator('#permission-block').click();await poll(()=>remote('clipboardResult === "NotAllowedError"'),'clipboard denial');
  await remote('stream.getTracks().forEach(track=>track.stop());sender.close();receiver.close()');
  console.log('PASS: native file selection/upload and clipboard consent');
  await application.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id).contentView.children.find(view=>!view.browserChrome&&view.getVisible()).webContents.reload(),shell.id);
  await poll(()=>remote('document.readyState === "complete" && !window.channel'),'reloaded fixture');await hit('#switch');
  assert.equal(await application.evaluate(async({BrowserWindow},id)=>BrowserWindow.fromId(id).webContents.executeJavaScript('getComputedStyle(document.querySelector(".tab-strip")).getPropertyValue("app-region")'),shell.id),'drag');
  assert.equal(await remote('typeof process+":"+typeof require+":"+typeof window.miniBrowser'),'undefined:undefined:undefined');
  console.log('PASS: input policy survives reload and leaves shell dragging, layout and sandbox unchanged');
  await remote("window.open('/popup','compatibility','width=420,height=520');void 0");
  let popupId;
  await poll(async()=>{popupId=await application.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows().filter(win => win.webContents.getURL() !== 'mini://icon-decoder/').find(win=>win.getParentWindow()?.id===id&&!win.webContents.isLoading())?.id,shell.id);return !!popupId;},'popup');
  await hit('#switch',1,popupId);
  assert.equal(await application.evaluate(async({BrowserWindow},{parent,popup})=>{const child=BrowserWindow.fromId(popup),owner=BrowserWindow.fromId(parent);return child.webContents.session===owner.contentView.children.find(view=>!view.browserChrome).webContents.session;},{parent:shell.id,popup:popupId}),true);
  await application.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id).destroy(),popupId);
  console.log('PASS: real popups receive the same page input policy and opener profile session');
 } finally {if(application)await application.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
run().catch(error=>{console.error(error);process.exitCode=1});
