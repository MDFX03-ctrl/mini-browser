'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PermissionStore, PermissionManager, permissionKeys, secureOrigin } = require('../src/permissions.cjs');
const root = path.resolve(__dirname, '..', '.cache', 'permission-unit-tests');
fs.mkdirSync(root, { recursive: true });
function directory(t) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => { assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(root) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
test('permissions persist separately by profile, top-level site, embedded origin and device type', t => {
  const dir = directory(t), other = directory(t), a = 'https://a.example', b = 'https://b.example';
  const store = new PermissionStore(dir);
  store.set(a, a, 'microphone', 'allow'); store.set(a, b, 'camera', 'block');
  const reopened = new PermissionStore(dir);
  assert.equal(reopened.get(a, a, 'microphone'), 'allow');
  assert.equal(reopened.get(b, a, 'microphone'), 'ask');
  assert.equal(reopened.get(a, a, 'camera'), 'ask');
  assert.equal(new PermissionStore(other).get(a, a, 'microphone'), 'ask');
  reopened.reset(a); assert.equal(new PermissionStore(dir).get(a, a, 'microphone'), 'ask');
  assert.deepEqual(permissionKeys('media', {mediaTypes:['video','audio']}), ['camera','microphone']);
  assert.deepEqual(permissionKeys('media', {mediaType:'unknown'}, true), []);
  assert.equal(secureOrigin('http://example.com'), null);
  assert.equal(secureOrigin('http://localhost:123/page'), 'http://localhost:123');
});
test('malformed files are preserved and test mode never reads or writes permissions', t => {
  const dir = directory(t), file = path.join(dir, 'permissions.json'); fs.writeFileSync(file, 'broken');
  const store = new PermissionStore(dir); assert.ok(store.error);
  assert.throws(() => store.set('https://a.test', 'https://a.test', 'microphone', 'allow'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  const isolated = new PermissionStore(dir, true); isolated.set('https://a.test','https://a.test','camera','allow');
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});
test('requests are bound to their owning active tab and navigation; stale and foreign responses cannot grant', t => {
  const dir = directory(t), content = new EventEmitter();
  content.isDestroyed = () => false; content.getURL = () => 'https://a.test/page'; content.mainFrame = { framesInSubtree:[{url:'https://a.test/page'}] };
  const controller = { profileId:'default', busy:() => false, tabs:{ active:{content,navigationId:1,mode:'page'}, items:[] }, showAccess:() => {}, publish:() => {} };
  let owner = controller;
  const manager = new PermissionManager({profiles:{bookmarkDirectory:() => dir}, testing:true, ownerOf:() => owner, publishAll:() => {}, allWindows:() => [controller]});
  let answer;
  manager.request('default',content,'media',value => answer = value,{requestingUrl:'https://a.test/page',mediaTypes:['audio']});
  const request = manager.state(controller).permissionPrompt;
  assert.deepEqual(request.labels,['Microphone']);
  assert.throws(() => manager.respond({},request.id,'allow'));
  owner = {}; manager.respond(controller,request.id,'allow'); assert.equal(answer,false);
  assert.equal(manager.store('default').get('https://a.test','https://a.test','microphone'),'ask');
  owner = controller;
  manager.request('default',content,'media',value => answer = value,{requestingUrl:'https://a.test/page',mediaTypes:['audio']});
  const second = manager.state(controller).permissionPrompt;
  content.emit('did-start-navigation',{},'https://b.test',false); assert.equal(answer,false);
  assert.throws(() => manager.respond(controller,second.id,'allow'));
  manager.request('default',content,'media',value => answer = value,{requestingUrl:'https://spoof.test',mediaTypes:['audio']}); assert.equal(answer,false);
  manager.request('default',content,'usb',value => answer = value,{requestingUrl:'https://a.test'}); assert.equal(answer,false);
  manager.request('default',content,'media',value => answer = value,{requestingUrl:'https://a.test',mediaTypes:[]}); assert.equal(answer,true);
  assert.equal(manager.check('default',content,'media','https://a.test',{mediaType:'unknown'}),false);
  let shared;
  const source = { id:'window:fixture:0', name:'Fixture', thumbnail:{toDataURL:()=>''} };
  const screenRequest = () => ({controller,content,valid:()=>true,profileId:'default',kind:'screen',origin:'https://a.test',topOrigin:'https://a.test',sources:[source],audioRequested:true,callback:value=>shared=value});
  manager.enqueue(screenRequest());let screen=manager.state(controller).permissionPrompt;
  manager.respond(controller,screen.id,'share','window:spoof:0',true);assert.equal(shared,null);
  manager.enqueue(screenRequest());screen=manager.state(controller).permissionPrompt;
  manager.respond(controller,screen.id,'share',source.id,false);assert.deepEqual(shared,{video:source});
  manager.enqueue(screenRequest());screen=manager.state(controller).permissionPrompt;
  manager.respond(controller,screen.id,'share',source.id,true);
  assert.deepEqual(shared,process.platform==='win32'?{video:source,audio:'loopback'}:{video:source});
  manager.cancelWindow(controller);
});
test('failed permission saves cannot grant access or change the in-memory decision', t => {
  const dir=directory(t), store=new PermissionStore(dir);
  fs.mkdirSync(path.join(dir,'permissions.json'));
  assert.throws(()=>store.set('https://a.test','https://a.test','microphone','allow'),/Could not save/);
  assert.equal(store.get('https://a.test','https://a.test','microphone'),'ask');
  assert.equal(fs.existsSync(path.join(dir,'permissions.json.tmp')),false);
});

test('missing and detached frames cannot crash permission checks or grant stale requests', t => {
  const dir = directory(t), origin = 'https://a.test', content = new EventEmitter();
  content.isDestroyed = () => false; content.getURL = () => origin + '/page';
  const controller = { profileId: 'default', busy: () => false,
    tabs: { active: { content, navigationId: 1, mode: 'page' } }, showAccess() {}, publish() {} };
  const manager = new PermissionManager({ profiles: { bookmarkDirectory: () => dir }, testing: true,
    ownerOf: () => controller, publishAll() {}, allWindows: () => [controller] });
  const live = { url: origin + '/page', detached: false };
  const disposed = { get url() { throw new Error('Render frame was disposed'); } };
  manager.store('default').set(origin, origin, 'microphone', 'allow');
  const check = () => manager.check('default', content, 'media', origin, { mediaType: 'audio' });
  content.mainFrame = { framesInSubtree: [null, disposed, live] };
  assert.equal(check(), true, 'a live matching frame still uses its saved grant');
  for (const frame of [null, {}, { framesInSubtree: [null, disposed] },
    { framesInSubtree: [{ url: origin, detached: true }] },
    { framesInSubtree: [{ url: origin, isDestroyed: () => true }] },
    { get framesInSubtree() { throw new Error('Main frame was disposed'); } }]) {
    content.mainFrame = frame;
    assert.equal(check(), false);
    let answer;
    manager.request('default', content, 'media', value => { answer = value; }, { requestingUrl: origin, mediaTypes: ['video'] });
    assert.equal(answer, false);
    assert.equal(manager.pending.size, 0);
  }
  Object.defineProperty(content, 'mainFrame', { configurable: true, get() { throw new Error('Main frame was disposed'); } });
  assert.equal(check(), false);
  Object.defineProperty(content, 'mainFrame', { configurable: true, value: { framesInSubtree: [live] }, writable: true });
  let answer;
  manager.request('default', content, 'media', value => { answer = value; }, { requestingUrl: origin, mediaTypes: ['video'] });
  const request = manager.state(controller).permissionPrompt;
  assert.ok(request);
  content.mainFrame = { framesInSubtree: [null, { url: origin, detached: true }] };
  manager.respond(controller, request.id, 'allow');
  assert.equal(answer, false, 'a frame disappearing while the prompt is open cannot receive a grant');
  assert.equal(manager.store('default').get(origin, origin, 'camera'), 'ask');
});
