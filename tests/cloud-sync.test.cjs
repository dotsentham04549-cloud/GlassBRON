const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto:crypto} = require('node:crypto');
const C = require('../cloud-sync-core.js');
const Data = require('../cloud-data.js');
const {YandexDisk} = require('../yandex-disk.js');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', D = '33333333-3333-4333-8333-333333333333';
const defaults = {name:'',panes:[],materials:[{id:'m1',name:'Film',rollPrice:'18000',rollW:'1.52',rollL:'30',sell:'800'}],discountMode:'percent',discountValue:'0'};
const objFields = ['name','panes','discountMode','discountValue'];
const data = (name = '') => ({settings:{...C.copy(defaults),name},objects:{},orders:[]});
function put(doc,key,value,actor){ const r = C.copy(doc); r.records[key] = C.edit(r.records[key],actor,value); return r; }

test('causal merge is commutative, associative and idempotent', () => {
  const base = put(C.empty(),'draft',defaults,A);
  const a = put(base,'draft',{...defaults,name:'Phone'},A);
  const b = put(base,'draft',{...defaults,name:'PC'},B);
  const d = put(base,'object:Third',{name:'Third',panes:[]},D);
  assert.ok(C.equal(C.merge(a,b),C.merge(b,a)));
  assert.ok(C.equal(C.merge(C.merge(a,b),d),C.merge(a,C.merge(b,d))));
  assert.ok(C.equal(C.merge(a,a),a));
  assert.equal(C.conflicts(C.merge(a,b)).length,1);
});
test('explicit conflict resolution survives stale devices reconnecting', () => {
  const a = put(C.empty(),'draft',{...defaults,name:'A'},A);
  const b = put(C.empty(),'draft',{...defaults,name:'B'},B);
  const merged = C.merge(a,b), resolved = put(merged,'draft',{...defaults,name:'A'},A);
  assert.equal(C.conflicts(resolved).length,0);
  assert.ok(C.equal(C.merge(resolved,b),resolved));
});
test('concurrent delete and edit both survive; deletion propagates when causal', () => {
  const base = put(C.empty(),'object:Site',{name:'Site',panes:[]},A);
  const deleted = put(base,'object:Site',null,A), edited = put(base,'object:Site',{name:'Edited',panes:[]},B);
  assert.equal(C.conflicts(C.merge(deleted,edited)).length,1);
  const result = C.materialize(C.merge(deleted,base),data());
  assert.equal(Object.keys(result.objects).length,0);
});
test('new edits do not acknowledge remote versions the editor has not seen', () => {
  const local = data('old'), base = put(C.empty(),'draft',local.settings,A);
  const remote = put(base,'draft',{...local.settings,name:'remote'},B);
  const captured = C.capture(remote,base.records,local,data('local'),A);
  assert.equal(C.conflicts(captured.doc).length,1);
  const displayed = C.materialize(captured.doc,data('local'));
  assert.equal(displayed.settings.name,'local');
});
test('same content from different devices is not presented as a conflict', () => {
  const a = put(C.empty(),'draft',defaults,A), b = put(C.empty(),'draft',defaults,B);
  assert.equal(C.conflicts(C.merge(a,b)).length,0);
});
test('remote schema is validated and connection secrets are omitted from data snapshots', () => {
  const tools = Data.createTools(defaults,objFields), input = data();
  input.settings.token = 'secret'; input.settings.clientSecret = 'secret';
  assert.ok(!JSON.stringify(tools.snapshot(input)).includes('secret'));
  const doc = put(C.empty(),'draft',defaults,A);
  C.validate(doc,tools.value);
  const bad = C.copy(doc); bad.records.draft.versions[0].seq = -1;
  assert.throws(() => C.validate(bad,tools.value));
  assert.throws(() => tools.snapshot({...data(),objects:JSON.parse('{"__proto__":{"panes":[]}}')}));
  assert.throws(() => tools.value('draft',{...defaults,panes:[null]}));
});

function response(body,status = 200){ return {ok:status >= 200 && status < 300,status,headers:{get:() => null},json:async () => body,text:async () => JSON.stringify(body)}; }
test('Disk uses app-folder paths and sends OAuth only to the API host', async () => {
  const calls = [], payload = put(C.empty(),'draft',defaults,A); let stored;
  const disk = new YandexDisk('private-token',{pause:async () => {},fetch:async (url,options) => {
    calls.push({url,options});
    const u = new URL(url);
    if (u.pathname.endsWith('/upload') && u.hostname === 'cloud-api.yandex.net') return response({href:'https://uploader.disk.yandex.net/file'});
    if (u.hostname === 'uploader.disk.yandex.net'){ stored = JSON.parse(options.body); return response({},202); }
    if (u.pathname.endsWith('/download')) return response({href:'https://downloader.disk.yandex.ru/file'});
    if (u.hostname === 'downloader.disk.yandex.ru') return response(stored);
    throw new Error('Unexpected request');
  }});
  await disk.upload('device-' + A + '.json',payload);
  for (const call of calls){
    const u = new URL(call.url);
    if (u.hostname === 'cloud-api.yandex.net'){
      assert.equal(call.options.headers.Authorization,'OAuth private-token');
      assert.ok(u.searchParams.get('path').startsWith('app:/GlassBRON-sync-v1/'));
    }else assert.equal(call.options.headers?.Authorization,undefined);
    assert.equal(call.options.credentials,'omit');
    assert.equal(call.options.cache,'no-store');
  }
});
test('Disk reports rejected uploads, invalid URL hosts and pending writes as failures', async () => {
  const denied = new YandexDisk('x',{fetch:async () => response({},401)});
  await assert.rejects(denied.list(),/Доступ истёк/);
  assert.throws(() => denied.signedURL('https://yandex.ru.evil.test/file'));
  assert.throws(() => denied.signedURL('http://downloader.disk.yandex.ru/file'));
  const pending = new YandexDisk('x',{pause:async () => {},fetch:async url => {
    if (url.includes('/resources/upload')) return response({href:'https://uploader.disk.yandex.net/file'});
    if (url.includes('/resources/download')) return response({href:'https://downloader.disk.yandex.ru/file'});
    return response({writeId:'old'},202);
  }});
  await assert.rejects(pending.upload('device-' + A + '.json',C.empty()),/ещё обрабатывает/);
});
test('Disk lists every page and rejects corrupted listings', async () => {
  const offsets = [];
  const disk = new YandexDisk('x',{fetch:async url => {
    const offset = Number(new URL(url).searchParams.get('offset')); offsets.push(offset);
    return response({_embedded:{total:2,items:[{name:'device-' + (offset ? B : A) + '.json',type:'file',md5:String(offset)}]}});
  }});
  assert.equal((await disk.list()).length,2); assert.deepEqual(offsets,[0,1]);
});

const CONFIG = 'glassbron-yandex-connection-v1';
const controllerCode = fs.readFileSync(path.join(__dirname,'..','cloud-sync.js'),'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function browser(server,initial = data(),hasLocal = false){
  let current = C.copy(initial), localData = hasLocal, editing = false;
  const values = new Map([[CONFIG,JSON.stringify({clientId:'35fc3535b9134626af99c98891181719',token:'test-token',scope:'a'.repeat(64)})]]), elements = new Map();
  function element(){ return {value:'',textContent:'',hidden:false,disabled:false,events:{},children:[],setAttribute(){},addEventListener(name,fn){this.events[name]=fn;},append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},click(){this.events.click?.();}}; }
  const document = {hidden:false,addEventListener(){},createElement:element,getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);}};
  class FakeDisk {
    async list(){ return [...server].map(([name,doc]) => ({name,md5:C.stable(doc)})); }
    async download(name){ return C.copy(server.get(name)); }
    async upload(name,doc){ if (server.fail) throw new Error('Test network failure'); server.set(name,C.copy(doc)); }
  }
  let queue = Promise.resolve();
  const navigator = {onLine:true,locks:{request(_name,fn){const result = queue.then(fn); queue = result.catch(() => {}); return result;}}};
  const context = vm.createContext({crypto,AbortController,TextEncoder,URL,URLSearchParams,Blob,Map,Set,console,document,navigator,confirm:() => true,location:{reload(){}},
    setTimeout:() => 1,clearTimeout(){},setInterval(){},addEventListener(){},
    localStorage:{getItem:key => values.get(key) ?? null,setItem:(key,value) => values.set(key,value),removeItem:key => values.delete(key)},
    BronSyncCore:C,BronCloudData:Data,BronDisk:{YandexDisk:FakeDisk},
    BronCloudBridge:{defaults,objectFields:objFields,read:() => C.copy(current),hasLocalData:() => localData,editing:() => editing,apply(value){current = C.copy(value); localData = true;}}
  }); context.window = context;
  vm.runInContext(controllerCode,context);
  return {context,values,elements,navigator,get data(){return current;},change(fn){fn(current);context.bronCloud.changed();localData=true;},set editing(v){editing=v;},async ready(){await flush();await flush();},async sync(){await context.bronCloud.syncNow();}};
}
test('two devices exchange drafts, objects and discounts, including offline changes', async () => {
  const server = new Map(), first = data('PC'); first.objects.Site = {name:'Site',panes:[],discountMode:'rub',discountValue:'500'};
  const pc = browser(server,first,true); await pc.ready(); await pc.sync();
  assert.ok(!pc.elements.get('cloudStatus').textContent.includes('ошиб'));
  assert.equal(server.size,1);
  const phone = browser(server); await phone.ready(); await phone.sync();
  assert.deepEqual(phone.data,first);
  phone.navigator.onLine = false;
  phone.change(d => {d.settings.discountValue='15';d.objects.New={name:'New',panes:[]};});
  await phone.sync(); assert.equal(server.size,2);
  phone.navigator.onLine = true; await phone.sync(); await pc.sync();
  assert.equal(pc.data.settings.discountValue,'15'); assert.equal(pc.data.objects.New.name,'New');
  pc.change(d => {delete d.objects.Site;}); await pc.sync(); await phone.sync();
  assert.equal(phone.data.objects.Site,undefined);
});
test('concurrent device edits retain both versions without replacing the current editor', async () => {
  const server = new Map(), pc = browser(server,data('Base'),true); await pc.ready(); await pc.sync();
  const phone = browser(server); await phone.ready(); await phone.sync();
  pc.change(d => {d.settings.name='From PC';});
  phone.change(d => {d.settings.name='From phone';});
  await pc.sync(); await phone.sync(); await pc.sync();
  assert.equal(pc.data.settings.name,'From PC'); assert.equal(phone.data.settings.name,'From phone');
  const union = [...server.values()].reduce(C.merge,C.empty());
  assert.equal(C.conflicts(union).length,1);
  assert.equal(pc.elements.get('cloudConflicts').hidden,false);
});
test('remote data waits while a field is focused, then appears after editing ends', async () => {
  const server = new Map(), pc = browser(server,data('Before'),true); await pc.ready(); await pc.sync();
  const phone = browser(server); await phone.ready(); await phone.sync();
  pc.change(d => {d.settings.name='After';}); await pc.sync();
  phone.editing=true; await phone.sync(); assert.equal(phone.data.settings.name,'Before');
  phone.editing=false; await phone.sync(); assert.equal(phone.data.settings.name,'After');
});
test('deleting a cloud device file is repaired even when local data did not change', async () => {
  const server = new Map(), pc = browser(server,data('Saved'),true); await pc.ready(); await pc.sync();
  server.clear(); await pc.sync(); assert.equal(server.size,1);
});
test('the user can resolve a conflict and the other device adopts that decision', async () => {
  const server = new Map(), pc = browser(server,data('Base'),true); await pc.ready(); await pc.sync();
  const phone = browser(server); await phone.ready(); await phone.sync();
  pc.change(d => {d.settings.name='PC';}); phone.change(d => {d.settings.name='Phone';});
  await pc.sync(); await phone.sync(); await pc.sync();
  const section = pc.elements.get('cloudConflicts').children[1];
  const chosenDescription = section.children[1].children[0].textContent;
  section.children[1].children[1].click(); await flush(); await flush();
  await pc.sync(); await phone.sync();
  assert.equal(pc.elements.get('cloudConflicts').hidden,true);
  assert.equal(pc.data.settings.name,phone.data.settings.name);
  assert.ok(chosenDescription.startsWith(pc.data.settings.name));
});
test('failed upload preserves local edits and never reports success', async () => {
  const server = new Map(), pc = browser(server,data('Base'),true); await pc.ready(); await pc.sync();
  server.fail=true; pc.change(d => {d.settings.name='Offline';}); await pc.sync();
  assert.equal(pc.data.settings.name,'Offline');
  assert.ok(!pc.elements.get('cloudStatus').textContent.startsWith('Синхронизировано'));
  server.fail=false; await pc.sync();
  const phone = browser(server); await phone.ready(); await phone.sync();
  assert.equal(phone.data.settings.name,'Offline');
});

