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

for (const tariff of ['std','prot']) for (const zone of ['city','suburb','region']){
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
    assert.ok(out.includes('Округление'));
    assert.ok(out.includes('Суммадоскидки'));
    assert.ok(out.includes('Скидка10,00%'));
    assert.ok(out.includes('-200'));
    assert.ok(out.includes('1800₽'));
    assert.ok(!out.includes('Мастеру'));
  }
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

