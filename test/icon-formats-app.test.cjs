'use strict';
const electron = require('./electron-driver.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { gzipSync, deflateSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const executablePath = fs.realpathSync(process.argv[2] || path.join(root,'.cache','installer-app','Mini Browser.exe'));
assert.ok(executablePath.startsWith(root+path.sep));
const temp = path.join(root,'.cache','tmp'); fs.mkdirSync(temp,{recursive:true});
const uuid = randomUUID(), formats = new Map();
let application, shell, base, imageRequests = 0, forbiddenRequests = 0;
function chunk(name, bytes) {
  const data = Buffer.concat([Buffer.from(name),bytes]); let crc = 0xffffffff;
  for (const value of data) { crc ^= value; for (let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  const header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(bytes.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([header,data,tail]);
}
function animatedPng() {
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
  const actl=Buffer.alloc(8);actl.writeUInt32BE(2);
  const frame=sequence=>{const data=Buffer.alloc(26);data.writeUInt32BE(sequence);data.writeUInt32BE(1,4);data.writeUInt32BE(1,8);data.writeUInt16BE(1,20);data.writeUInt16BE(10,22);return data;};
  const sequence=Buffer.alloc(4);sequence.writeUInt32BE(2);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('acTL',actl),chunk('fcTL',frame(0)),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('fcTL',frame(1)),chunk('fdAT',Buffer.concat([sequence,deflateSync(Buffer.from([0,0,0,255,255]))])),chunk('IEND',Buffer.alloc(0))]);
}
const server = http.createServer((req,res)=>{
  if(req.url.startsWith('/trap')) { forbiddenRequests++;res.setHeader('Content-Type','image/png');return res.end(fs.readFileSync(path.join(root,'assets','icon.png'))); }
  if(req.url==='/favicon.ico') {res.writeHead(404);return res.end();}
  if(req.url.startsWith('/icon/')) {const item=formats.get(req.url.slice(6));imageRequests++;if(!item){res.writeHead(404);return res.end();}res.setHeader('Content-Type',item.type);return res.end(item.bytes);}
  const name=req.url.slice(6),item=formats.get(name);res.setHeader('Content-Type','text/html');
  const href=item?.inline || `${base}/icon/${name}`;
  return res.end(`<title>${name}</title><link rel="icon" href="${href.replaceAll('&','&amp;').replaceAll('"','&quot;')}"><p>Image fixture</p>`);
});
async function poll(check,label,timeout=20000) {const start=Date.now();while(Date.now()-start<timeout){if(await check())return;await new Promise(r=>setTimeout(r,75));}throw new Error('Timed out: '+label);}
const state=()=>shell.evaluate(()=>window.miniBrowser.getState());
async function launch() {
  const env={...process.env,MINI_BROWSER_TEST:'1',MINI_BROWSER_TEST_PROFILE:uuid,TEMP:temp,TMP:temp};delete env.ELECTRON_RUN_AS_NODE;
  application=await electron.launch({executablePath,cwd:root,env});shell=await application.firstWindow();await shell.waitForURL('mini://app/index.html');
}
async function pixels(icon) {return shell.evaluate(async source=>{const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=32;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return {width:image.naturalWidth,height:image.naturalHeight,pixel:[...ctx.getImageData(16,16,1,1).data]};},icon);}
async function run() {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
  try {
    await launch();
    if(process.env.MINI_BROWSER_LIVE_ICONS==='1') {
      await application.evaluate(async({session})=>{const proxy=process.env.HTTPS_PROXY||process.env.HTTP_PROXY;if(proxy)await session.fromPartition('test-pages').setProxy({proxyRules:new URL(proxy).host});});
      const url='https://platform.deepseek.com/';await shell.evaluate(url=>window.miniBrowser.addBookmark(url,'DeepSeek Platform'),url);
      await poll(async()=>!!(await state()).bookmarks.find(b=>b.url===url)?.icon,'official DeepSeek Platform SVG',65000);
      assert.equal((await pixels((await state()).bookmarks.find(b=>b.url===url).icon)).width,32);
      console.log('PASS: live DeepSeek Platform official SVG loads and is cached as PNG');
      await application.evaluate(async({session})=>{await session.fromPartition('test-pages').setProxy({mode:'direct'});await session.fromPartition('test-pages').closeAllConnections();});
    }
    const generated=await shell.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=32;const ctx=canvas.getContext('2d');ctx.fillStyle='#e04b24';ctx.fillRect(0,0,32,32);return Object.fromEntries(['png','jpeg','webp'].map(type=>[type,canvas.toDataURL('image/'+type).split(',')[1]]));});
    for(const [name,data] of Object.entries(generated))formats.set(name,{bytes:Buffer.from(data,'base64'),type:'image/'+name});
    formats.set('png-wrong-mime',{bytes:formats.get('png').bytes,type:'text/html'});
    formats.set('jpeg-octet-stream',{bytes:formats.get('jpeg').bytes,type:'application/octet-stream'});
    formats.set('apng',{bytes:animatedPng(),type:'image/apng'});
    for(const [name,file,type] of [['gif','animated.gif','image/gif'],['animated-webp','animated.webp','image/webp'],['avif','green.avif','image/avif']])formats.set(name,{bytes:fs.readFileSync(path.join(root,'test','fixtures','icons',file)),type});
    const bmp=Buffer.alloc(58);bmp.write('BM');bmp.writeUInt32LE(58,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);bmp.writeInt32LE(1,18);bmp.writeInt32LE(1,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp[56]=255;formats.set('bmp',{bytes:bmp,type:'image/bmp'});
    for(const [name,kind] of [['ico',1],['cur',2]]) {const bytes=formats.get('png').bytes,header=Buffer.alloc(22);header.writeUInt16LE(kind,2);header.writeUInt16LE(1,4);header[6]=header[7]=32;if(kind===1){header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);}header.writeUInt32LE(bytes.length,14);header.writeUInt32LE(22,18);formats.set(name,{bytes:Buffer.concat([header,bytes]),type:'image/x-icon'});}
    const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#008000"/></svg>');
    formats.set('svg',{bytes:svg,type:'image/svg+xml'});formats.set('svg-wrong-mime',{bytes:svg,type:'image/x-icon'});formats.set('svgz',{bytes:gzipSync(svg),type:'image/svg+xml'});
    formats.set('inline-svg',{inline:'data:image/svg+xml,'+encodeURIComponent(svg.toString())});
    formats.set('inline-png',{inline:'data:image/png;base64,'+generated.png});
    formats.set('svg-untrusted',{type:'image/svg+xml',bytes:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><script>window.__iconScriptRan=true;fetch('${base}/trap/script');</script><image href="${base}/trap/image" width="1" height="1"/><rect width="32" height="32" fill="#008000"/></svg>`)});
    formats.set('bad',{type:'image/png',bytes:Buffer.from('not an image')});
    await shell.evaluate(()=>{window.__iconScriptRan=false;});
    for(const [name] of formats) {
      if(name==='bad')continue;
      const url=`${base}/page/${name}`;await shell.evaluate(({url,name})=>window.miniBrowser.addBookmark(url,name),{url,name});
      await poll(async()=>!!(await state()).bookmarks.find(b=>b.url===url)?.icon,name+' bookmark');
      const result=await pixels((await state()).bookmarks.find(b=>b.url===url).icon);
      assert.equal(result.width,32);assert.equal(result.height,32);assert.ok(result.pixel[3]>0,name+' has visible pixels');
      if(name.startsWith('svg')||name==='inline-svg')assert.deepEqual(result.pixel,[0,128,0,255],name+' renders the actual SVG');
      if(name==='apng')assert.deepEqual(result.pixel,[255,0,0,255],'animated icons use their initial frame');
      await shell.evaluate(url=>window.miniBrowser.navigate(url),url);
      await poll(async()=>{const s=await state();return s.url===url&&!s.loading&&!!s.tabs.find(t=>t.id===s.activeTabId).icon;},name+' tab');
      const tabState=await state();assert.equal((await pixels(tabState.tabs.find(t=>t.id===tabState.activeTabId).icon)).width,32);
      console.log('PASS: '+name+' bookmark, tab and PNG cache');
    }
    assert.equal(forbiddenRequests,0,'SVG cannot fetch external resources');assert.equal(await shell.evaluate(()=>window.__iconScriptRan),false,'SVG scripts never run');
    const bad=`${base}/page/bad`;await shell.evaluate(url=>window.miniBrowser.addBookmark(url,'Broken image'),bad);await new Promise(r=>setTimeout(r,300));assert.equal((await state()).bookmarks.find(b=>b.url===bad).icon,undefined);
    await shell.evaluate(url=>window.miniBrowser.removeBookmark(url),bad);
    await shell.evaluate(()=>window.miniBrowser.home());
    const saved=(await state()).bookmarks;const before=imageRequests;
    await application.close();application=null;await launch();
    assert.deepEqual((await state()).bookmarks,saved);await new Promise(r=>setTimeout(r,300));assert.equal(imageRequests,before,'restart uses local PNGs');
    assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
    assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].contentView.children.length),2,'only the existing page and chrome views');
    const original=shell;await shell.evaluate(()=>window.miniBrowser.createProfile('Separate icons'));const ids=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>w.id));shell=application.window(ids.find(id=>id!==original.id));await shell.waitForURL('mini://app/index.html');assert.deepEqual((await state()).bookmarks,[]);
    console.log('PASS: SVG scripts/resources blocked, corrupt image fallback, cached restart, profile isolation and no extra decoder view/window');
  } finally {if(application)await application.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
