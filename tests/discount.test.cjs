const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function functionSource(name){
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing function ${name}`);
  const end = html.indexOf('\n}', start);
  // These production functions end with a closing brace at column zero.
  return html.slice(start, end + 2);
}
function app(){
  const elements = new Map();
  const context = vm.createContext({
    localStorage: {getItem: () => null},
    document: {getElementById: id => {
      if (!elements.has(id)) elements.set(id, {innerHTML:''});
      return elements.get(id);
    }},
    doPrint: (output, title) => { context.printed = {output, title}; }
  });
  const setup = html.slice(html.indexOf('const KEY ='), html.indexOf('/* ---------- inputs ---------- */'));
  const names = ['figures','rounding','discounted','renderSummary','printClient','docHead','snapshot','withSnapshot'];
  const makeNo = html.match(/^function makeNo\(d\).*$/m)[0];
  vm.runInContext(setup + '\n' + makeNo + '\n' + names.map(functionSource).join('\n') + `
    globalThis.api = {
      get state(){ return state; },
      reset(patch = {}){ state = Object.assign(clone(DEFAULTS), patch); },
      active(patch = {}){ state = ensureMaterials(Object.assign(clone(DEFAULTS), patch)); },
      figures, snapshot, withSnapshot, restoreObject,
      summary(){ const F = figures(); renderSummary(F, {total:400}, 0, F.Wm * 100); },
      print(kind){ printClient({no:'test', date:'2026-11-11'}, kind); }
    };
  `, context);
  return {api:context.api, elements, context};
}
function masterPayment(view){
  return view.match(/<span>Мастеру<\/span><span>([^<]+)<\/span>/)[1];
}
function profit(view){
  const text = view.match(/<span>Прибыль<\/span><strong[^>]*>([^<]+)<\/strong>/)[1];
  return Number(text.replace(/[^\d−-]/g, '').replace('−','-'));
}

test('all inline scripts parse', () => {
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
});

for (const tariff of ['std','opt','prot']) for (const zone of ['city','suburb','region']){
  test(`discount changes company profit, never master payment: ${tariff}/${zone}`, () => {
    const {api, elements} = app();
    api.reset({tariff, zone, minOrder:'10000', freeFrom:'20000', roundMode:'nearest',
      panes:[{n:'Small',h:'25',w:'35',q:'2',bead:true},{n:'Large',h:'140',w:'65',q:'2',bead:false}]});
    const base = api.figures(); api.summary();
    const baseView = elements.get('result').innerHTML;
    for (const [mode, value] of [['percent','10'],['rub','1234'],['percent','100']]){
      api.state.discountMode = mode; api.state.discountValue = value;
      const F = api.figures(); api.summary();
      const view = elements.get('result').innerHTML;
      const expected = mode === 'rub' ? 1234 : Math.round(base.revenue * Number(value) / 100);
      assert.equal(F.revenue, base.revenue - expected);
      for (const field of ['work','bill','beadBill','travel','masterTravel']) assert.equal(F[field], base[field]);
      assert.equal(masterPayment(view), masterPayment(baseView));
      assert.equal(profit(view), profit(baseView) - expected);
    }
  });
}

test('zero, negative, malformed and excessive discounts stay bounded', () => {
  const {api} = app();
  api.reset(); const base = api.figures().revenue;
  for (const mode of ['rub','percent']){
    api.state.discountMode = mode;
    for (const value of ['0','-10','','bad']){
      api.state.discountValue = value;
      assert.equal(api.figures().revenue, base);
    }
    api.state.discountValue = '999999999';
    assert.equal(api.figures().revenue, 0);
  }
  api.reset({discountMode:'percent',discountValue:'12,5'});
  assert.equal(api.figures().discount, Math.round(base * 0.125));
});

test('discount follows rounding and is shown in both document kinds', () => {
  const {api, context} = app();
  api.reset({panes:[{n:'Glass',h:'100',w:'100',q:'1'}], minOrder:'0', extra:'25',
    freeFrom:'0', roundMode:'down', roundStep:'100', discountMode:'percent',discountValue:'10'});
  const F = api.figures();
  assert.equal(F.exact, 2025);
  assert.equal(F.beforeDiscount, 2000);
  assert.equal(F.discount, 200);
  assert.equal(F.revenue, 1800);
  for (const kind of ['prelim','final']){
    api.print(kind);
    const out = context.printed.output.replace(/[\s\u00a0\u202f]/g,'');
    assert.ok(!out.includes('Округление'));
    assert.ok(out.includes('Суммадоскидки'));
    assert.ok(out.includes('Скидка10,00%'));
    assert.ok(out.includes('-200'));
    assert.ok(out.includes('1800₽'));
    assert.ok(!out.includes('Мастеру'));
  }
  api.summary();
  assert.ok(context.document.getElementById('result').innerHTML.includes('Округление'));
});

test('saved snapshot keeps discount; old objects and documents have none', () => {
  const {api} = app();
  api.reset({discountMode:'rub',discountValue:'700'});
  const snap = api.snapshot(), expected = api.figures().revenue;
  api.state.discountValue = '2000';
  api.withSnapshot(snap, () => assert.equal(api.figures().revenue, expected));
  assert.equal(api.state.discountValue, '2000');
  api.restoreObject({name:'Old object',panes:api.state.panes});
  assert.equal(api.state.discountValue, '0');
  api.restoreObject({discountMode:'percent',discountValue:'15'});
  assert.equal(api.state.discountMode, 'percent');
  assert.equal(api.state.discountValue, '15');
  const old = api.snapshot(); delete old.discountMode; delete old.discountValue;
  api.withSnapshot(old, () => assert.equal(api.figures().discount, 0));
});

test('three beads adjust only bead surcharge, not base work, material or cut allowance',()=>{
 const {api}=app();
 const pane={n:'Window',h:'100',w:'100',q:'1',bead:true};
 api.reset({panes:[pane],beadSides:'4',minOrder:'0',freeFrom:'0',roundMode:'none'});
 const four=api.figures();
 api.state.beadSides='3';const three=api.figures();
 assert.equal(four.revenue,2400);assert.equal(three.revenue,2300);
 assert.equal(four.beadClient,400);assert.equal(three.beadClient,300);
 assert.equal(four.laborBead,650);assert.equal(three.laborBead,600);
 for(const k of ['labor','workP','matRev','m','glass','bill','beadBill'])assert.equal(three[k],four[k]);
 api.state.tariff='opt';assert.equal(api.figures().workP,1575);assert.equal(api.figures().beadRev,0);
 api.state.tariff='prot';assert.equal(api.figures().workP,1700);
 api.state.tariff='opt';api.state.bead3Factor='100';assert.equal(api.figures().workP,1700);assert.equal(api.figures().laborBead,650);
});
test('bead factor remains bounded; unmarked standard glass and master discount protection remain unchanged',()=>{
 const {api,elements}=app();
 api.reset({panes:[{n:'Window',h:'100',w:'100',q:'1',bead:false}],beadSides:'3',minOrder:'0',freeFrom:'0',roundMode:'none'});
 assert.equal(api.figures().revenue,2000);assert.equal(api.figures().beadBill,0);
 api.state.panes[0].bead=true;api.state.bead3Factor='999';assert.equal(api.figures().beadClient,400);
 api.state.bead3Factor='-5';assert.equal(api.figures().beadClient,0);assert.equal(api.figures().laborBead,450);
 api.state.bead3Factor='75';api.summary();const base=masterPayment(elements.get('result').innerHTML);
 api.state.discountValue='30';api.summary();assert.equal(masterPayment(elements.get('result').innerHTML),base);
});
test('legacy snapshots and saved objects retain four beads and their old prices',()=>{
 const {api}=app();
 api.reset({tariff:'prot',beadSides:'4',panes:[{n:'Window',h:'100',w:'100',q:'1',bead:true}],minOrder:'0',freeFrom:'0',roundMode:'none'});
 const old=api.snapshot(),previous=api.figures().revenue;delete old.beadSides;delete old.bead3Factor;
 api.state.tariff='opt';assert.notEqual(api.figures().revenue,previous);
 api.withSnapshot(old,()=>{assert.equal(api.figures().beadSides,4);assert.equal(api.figures().revenue,previous);});
 api.restoreObject({panes:old.panes,tariff:'prot'});assert.equal(api.figures().beadSides,4);
});
test('customer documents specify the mounting method for each tariff',()=>{
 const {api,context}=app();
 for(const tariff of ['std','opt','prot']){
  api.reset({tariff,beadSides:'3',panes:[{n:'Window',h:'100',w:'100',q:'1',bead:true}]});
  api.print('final');assert.ok(context.printed.output.includes(tariff==='prot'?'под все 4 штапика':'под 3 штапика, без верхнего'));
  assert.ok(context.printed.output.includes('Тариф «'+api.figures().tariffName+'»'));
 }
});

test('historical tariff formulas stay compatible while the interface offers two tariffs',()=>{
 const {api}=app();
 const panes=[{n:'Window',h:'100',w:'100',q:'1',bead:false}];
 for(const [tariff,revenue,beads,rate,name] of [['std',2000,0,450,'Стандарт'],['opt',2375,1,600,'Оптимальный'],['prot',2500,1,650,'Защита']]){
  api.reset({tariff,beadSides:tariff==='opt'?'4':'3',panes,minOrder:'0',freeFrom:'0',roundMode:'none'});
  const f=api.figures();assert.equal(f.revenue,revenue);assert.equal(f.beads,beads);
  assert.equal(beads?f.laborBead:f.labor,rate);assert.equal(f.beadRev,0);assert.equal(f.tariffName,name);
 }
 assert.equal((html.match(/<input type="radio" name="tariff"/g)||[]).length,2);
 assert.ok(!html.includes('value="opt"'));
 assert.ok(!html.includes('data-k="bead3Factor"'));
 assert.ok(!html.includes('id="beadAll"'));assert.ok(!html.includes('class="mount-options"'));
});

test('active saved calculations and objects use four beads at the full existing rates',()=>{
 const {api}=app();
 const patch={panes:[{n:'Window',h:'100',w:'100',q:'1',bead:true}],minOrder:'0',freeFrom:'0',roundMode:'none'};
 for(const tariff of ['std','opt','prot']){
  api.active({...patch,tariff,beadSides:'3',bead3Factor:'0'});
  assert.equal(api.state.tariff,tariff==='std'?'std':'prot');
  assert.equal(api.figures().beadSides,4);assert.equal(api.figures().laborBead,650);
  assert.equal(api.figures().revenue,tariff==='std'?2400:2500);
  api.restoreObject({tariff,beadSides:'3',bead3Factor:'0',panes:patch.panes});
  assert.equal(api.figures().beadSides,4);assert.equal(api.figures().revenue,tariff==='std'?2400:2500);
 }
});

test('issued three-bead documents retain their original amounts and do not alter the editor',()=>{
 const {api,context}=app();
 const patch={panes:[{n:'Window',h:'100',w:'100',q:'1',bead:true}],minOrder:'0',freeFrom:'0',roundMode:'none'};
 api.active({...patch,tariff:'prot'});
 for(const [tariff,total] of [['std',2300],['opt',2375],['prot',2375]]){
  api.withSnapshot({...api.snapshot(),tariff,beadSides:'3',bead3Factor:'75'},()=>{
   assert.equal(api.figures().revenue,total);api.print('final');
   assert.ok(context.printed.output.includes('под 3 штапика, без верхнего'));
  });
  assert.equal(api.state.tariff,'prot');assert.equal(api.figures().revenue,2500);
 }
});
