/* Causal multi-value registers: concurrent edits survive until the user resolves them. */
(function(root){
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  function stable(value){
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  const equal = (a,b) => stable(a) === stable(b);
  const empty = () => ({app:'glassbron-sync', schema:1, records:{}});
  const register = () => ({context:{}, versions:[]});
  const dot = v => v.actor + ':' + v.seq;
  function mergeRegister(a = register(), b = register()){
    const context = {...a.context};
    for (const [actor, seq] of Object.entries(b.context)) context[actor] = Math.max(context[actor] || 0, seq);
    const av = new Set(a.versions.map(dot)), bv = new Set(b.versions.map(dot)), versions = new Map();
    for (const [left,right,ids] of [[a,b,bv],[b,a,av]]) for (const v of left.versions){
      if (ids.has(dot(v)) || v.seq > (right.context[v.actor] || 0)){
        const previous = versions.get(dot(v));
        if (previous && !equal(previous,v)) throw new Error('Повреждена история синхронизации.');
        versions.set(dot(v), copy(v));
      }
    }
    return {context, versions:[...versions.values()].sort((x,y) => dot(x).localeCompare(dot(y)))};
  }
  function merge(a,b){
    const result = empty();
    for (const key of new Set([...Object.keys(a.records),...Object.keys(b.records)])) result.records[key] = mergeRegister(a.records[key], b.records[key]);
    return result;
  }
  function edit(base, actor, value, now = new Date().toISOString()){
    base = base || register();
    const seq = (base.context[actor] || 0) + 1;
    return {context:{...base.context,[actor]:seq}, versions:[{actor,seq,at:now,value:copy(value)}]};
  }
  function uniqueVersions(reg){
    const found = new Map();
    for (const v of (reg || register()).versions) if (!found.has(stable(v.value))) found.set(stable(v.value),v);
    return [...found.values()];
  }
  function conflicts(doc){
    return Object.entries(doc.records).filter(([,r]) => uniqueVersions(r).length > 1).map(([key,reg]) => ({key, versions:uniqueVersions(reg)}));
  }
  function flatten(data){
    const records = {draft:copy(data.settings)};
    for (const [name,value] of Object.entries(data.objects || {})) records['object:' + name] = copy(value);
    for (const order of data.orders || []) records['order:' + JSON.stringify([order.kind || 'prelim',order.no,order.date])] = copy(order);
    return records;
  }
  function materialize(doc,current){
    const result = {settings:copy(current.settings), objects:Object.create(null), orders:[]}, previous = flatten(current);
    for (const [key,reg] of Object.entries(doc.records)){
      const versions = uniqueVersions(reg);
      if (!versions.length) continue;
      // During a conflict, retain what this device shows; never silently pick a winner.
      let value = versions.length === 1 ? versions[0].value : (previous[key] === undefined ? null : previous[key]);
      if (key === 'draft'){ if (value !== null) result.settings = copy(value); }
      else if (key.startsWith('object:')){ if (value !== null) result.objects[key.slice(7)] = copy(value); }
      else if (key.startsWith('order:')){ if (value !== null) result.orders.push(copy(value)); }
    }
    result.orders.sort((a,b) => String(b.date).localeCompare(String(a.date)));
    return result;
  }
  function capture(doc, known, previous, current, actor){
    const next = copy(doc), before = flatten(previous), after = flatten(current), view = copy(known);
    for (const key of new Set([...Object.keys(before),...Object.keys(after)])){
      const oldValue = before[key] === undefined ? null : before[key], newValue = after[key] === undefined ? null : after[key];
      if (equal(oldValue,newValue) && next.records[key]) continue;
      const reg = edit(known[key],actor,newValue);
      next.records[key] = mergeRegister(next.records[key],reg); view[key] = reg;
    }
    return {doc:next,known:view,previous:copy(current)};
  }
  function validate(doc, validateValue){
    if (!doc || doc.app !== 'glassbron-sync' || doc.schema !== 1 || !doc.records || Array.isArray(doc.records)) throw new Error('Неподдерживаемый файл синхронизации.');
    if (Object.keys(doc.records).length > 10000) throw new Error('Слишком много записей для синхронизации.');
    for (const [key,reg] of Object.entries(doc.records)){
      if (!(key === 'draft' || key.startsWith('object:') || key.startsWith('order:')) || key.length > 1500) throw new Error('Повреждена запись синхронизации.');
      if (!reg || !reg.context || Array.isArray(reg.context) || !Array.isArray(reg.versions) || !reg.versions.length || reg.versions.length > 100) throw new Error('Повреждена история синхронизации.');
      for (const [actor,seq] of Object.entries(reg.context)) if (!/^[a-f0-9-]{36}$/.test(actor) || !Number.isSafeInteger(seq) || seq < 1) throw new Error('Повреждена версия синхронизации.');
      const dots = new Set();
      for (const v of reg.versions){
        if (!v || !/^[a-f0-9-]{36}$/.test(v.actor) || !Number.isSafeInteger(v.seq) || v.seq < 1 || reg.context[v.actor] !== v.seq || dots.has(dot(v)) || !Number.isFinite(Date.parse(v.at))) throw new Error('Повреждена версия синхронизации.');
        dots.add(dot(v)); if (v.value !== null) validateValue(key,v.value);
      }
    }
    return copy(doc);
  }
  const api = {copy,equal,stable,empty,register,mergeRegister,merge,edit,uniqueVersions,conflicts,flatten,materialize,capture,validate};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BronSyncCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

