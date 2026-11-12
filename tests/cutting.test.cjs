const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function source(name){
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return html.slice(start, html.indexOf('\n}',start)+2);
}
function app(){
  const context = vm.createContext({localStorage:{getItem:()=>null},doPrint:output=>{context.output=output;}});
  const setup = html.slice(html.indexOf('const KEY ='),html.indexOf('/* ---------- inputs ---------- */'));
  const functions = ['expand','place','fmtDimension','cutSize','cutSizes','label','cutTable','figures','rounding','discounted','docHead','bandSVG','masterScheme','marginBox','printCut'];
  vm.runInContext(setup+'\n'+functions.map(source).join('\n')+'\n'+html.match(/^function makeNo\(d\).*$/m)[0]+`
    const BAND=750, BAND_MM=268;
    let lastLayout;
    globalThis.api={cutSize,cutSizes,label,cutTable,printCut,
      layout(pane,margin,orientation=1){
        state.panes=[pane];state.margin=String(margin);
        const expanded=expand(152,margin);
        const result=place(expanded.items,expanded.items.map((_,i)=>i),expanded.items.map(()=>orientation),0,152);
        lastLayout={total:result.total,placed:result.placed.map((p,i)=>({...p.it,x:p.x,y:p.y,pw:p.pw,ph:p.ph,rotated:p.rotated,no:i+1}))};
        return lastLayout;
      }
    };
  `,context);
  return {api:context.api,context};
}
const glass={n:'Гостиная',h:'140',w:'65',q:'1'};
for(const orientation of [1,2]) test(`original and ready cutting sizes retain height × width after rotation ${orientation}`,()=>{
  const {api}=app(), L=api.layout(glass,1,orientation), p=L.placed[0];
  assert.equal(p.rotated,orientation===2);
  assert.equal(p.size,'140×65');
  assert.equal(api.cutSize(p),'142 × 67');
  const table=api.cutTable(L), svg=api.label(p,0,0,p.pw,p.ph,2.6,'');
  assert.ok(table.indexOf('Стекло · 140×65 см')<table.indexOf('Резать · 142 × 67 см'));
  assert.ok(svg.includes('Стекло: 140×65'));
  assert.ok(svg.includes('Резать: 142 × 67 см'));
});
test('fractional entered dimensions and allowance are not rounded to one decimal',()=>{
  const {api}=app(),p=api.layout({...glass,h:'100,25',w:'40,75'},0.25).placed[0];
  assert.equal(p.size,'100,25×40,75');
  assert.equal(api.cutSize(p),'100,75 × 41,25');
  const zero=api.layout(glass,0).placed[0];
  assert.equal(api.cutSize(zero),'140 × 65');
});
test('a seam displays whole glass size but instructs cutting the actual individual part',()=>{
  const {api}=app(),L=api.layout({...glass,h:'300',w:'200'},1);
  assert.ok(L.placed.length>1);
  for(const p of L.placed){
    assert.equal(p.seam,true);
    assert.equal(p.size,'300×200');
    assert.ok(p.pw<=152);
    assert.equal(api.cutSize(p),`${p.ph.toLocaleString('ru-RU',{maximumFractionDigits:6})} × ${p.pw.toLocaleString('ru-RU',{maximumFractionDigits:6})}`);
    assert.ok(api.cutSizes(p).includes('Всё стекло'));
    assert.ok(api.cutSizes(p).includes('Резать часть'));
  }
});
test('the actual master print includes paired dimensions in diagram and cutting table',()=>{
  const {api,context}=app();
  api.layout(glass,1,2);api.printCut();
  assert.ok(context.output.includes('Стекло: 140×65'));
  assert.ok(context.output.includes('Резать: 142 × 67 см'));
  assert.ok(context.output.includes('Стекло · 140×65 см'));
  assert.ok(context.output.includes('Резать · 142 × 67 см'));
});
test('room names are escaped in both cutting diagram and table',()=>{
  const {api}=app(),L=api.layout({...glass,n:'<img src=x onerror=alert(1)>'},1),p=L.placed[0];
  for(const output of [api.cutTable(L),api.label(p,0,0,p.pw,p.ph,2.6,'')]){
    assert.ok(!output.includes('<img'));
    assert.ok(output.includes('&lt;img'));
  }
});
