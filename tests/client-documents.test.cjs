const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const D=require('../client-documents.js'),Data=require('../cloud-data.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function app(){
 const elements=new Map();
 const ctx=vm.createContext({localStorage:{getItem:()=>null},BronClientDocuments:D,document:{getElementById:id=>elements.get(id)}});
 vm.runInContext(html.slice(html.indexOf('const KEY ='),html.indexOf('/* ---------- inputs ---------- */'))+'\nglobalThis.defaults=DEFAULTS;globalThis.fields=OBJ_FIELDS;globalThis.stateRef=state;globalThis.restore=restoreObject;',ctx);
 for(const name of ['figures','rounding','discounted','missingDocumentFields']){
   const a=html.indexOf(`function ${name}(`),line=html.slice(a,html.indexOf('\n',a));
   vm.runInContext(line.endsWith('}')?line:html.slice(a,html.indexOf('\n}',a)+2),ctx);
 }
 return {ctx,s:ctx.stateRef,defaults:ctx.defaults,fields:ctx.fields};
}
test('contract, act and care use approved montage warranty and preserve total after discount',()=>{
 const {s}=app();Object.assign(s,{client:'Иван',address:'Воронеж',contractNo:'25',contractMaterial:'SOLARNEX Safety 8 mil',contractStart:'2026-11-15',contractEnd:'2026-11-16'});
 const figures={revenue:5220,discount:580,glass:2.5,bill:2.9,sell:800,matRev:2320,rows:[{n:'Кухня',h:120,w:50,q:1,bead:false}]};
 for(const kind of ['contract','act','care']){
   const m=D.model(kind,{settings:s,figures,date:'12.11.2026'}),out=D.render(m);
   assert.ok(out.includes('12 месяцев'));assert.ok(out.includes('SOLARNEX'));
   assert.ok(!out.includes('210 мкм'));assert.ok(!out.includes('Округление'));
   assert.ok(out.includes('Иван'));assert.ok(out.includes('Воронеж'));
   if(kind!=='care')assert.ok(out.includes('5 220 ₽'));
 }
});
test('preview escapes all client supplied text including table fields',()=>{
 const payload='<img src=x onerror=alert(1)>';
 const settings=new Proxy({},{get:()=>payload});
 for(const kind of ['contract','act','care']){
   const out=D.render(D.model(kind,{settings,figures:{rows:[{n:payload,h:100,w:100,q:1}]},date:payload}));
   assert.ok(!out.includes('<img'));assert.ok(out.includes('&lt;img'));
 }
});
test('guard requires agreed payment, material and dates and rejects invalid advance/date order',()=>{
 const {ctx,s}=app();
 assert.ok(ctx.missingDocumentFields('contract').includes('маркировка материала'));
 Object.assign(s,{client:'Иван',address:'Адрес',contractMaterial:'Film',contractStart:'2026-11-16',contractEnd:'2026-11-15',contractAdvance:'bad'});
 assert.ok(ctx.missingDocumentFields('contract').includes('окончание не раньше начала'));
 assert.ok(ctx.missingDocumentFields('contract').includes('корректный аванс в пределах суммы'));
 s.contractEnd='2026-11-17';s.contractAdvance='0';
 assert.equal(ctx.missingDocumentFields('contract').length,0);
 assert.ok(ctx.missingDocumentFields('care').includes('срок первой мойки'));
});
test('legal snapshots and new document kinds survive cloud roundtrip; credentials do not',()=>{
 const {s,defaults,fields}=app();
 s.contractNo='25';s.contractMaterial='Exact film';s.contractFirstWash='По инструкции';s.token='secret';
 const tools=Data.createTools(defaults,fields);
 for(const kind of ['contract','act','care']){
   const result=tools.snapshot({settings:s,objects:{Client:{panes:s.panes,contractNo:'25',contractMaterial:'Exact film'}},orders:[{kind,no:'25',date:'2026-11-12',total:5220,area:2.5,templateVersion:D.version,snap:s}]});
   assert.equal(result.orders[0].kind,kind);assert.equal(result.orders[0].templateVersion,D.version);
   assert.equal(result.orders[0].snap.contractMaterial,'Exact film');
   assert.equal(result.objects.Client.contractNo,'25');assert.ok(!JSON.stringify(result).includes('secret'));
 }
});
test('opening a legacy client cannot carry over another client contract terms',()=>{
 const {ctx,s}=app();s.contractNo='PRIVATE';s.contractMaterial='Other';s.contractReceived='Paid';
 ctx.restore({name:'Old client',panes:s.panes});
 assert.equal(s.contractNo,'');assert.equal(s.contractMaterial,'');assert.equal(s.contractReceived,'');
});
