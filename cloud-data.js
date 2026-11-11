/* Shared validation for local and remote data; credentials are never part of a snapshot. */
(function(root){
  'use strict';
  function createTools(defaults,objectFields){
    const copy = value => JSON.parse(JSON.stringify(value));
    function text(value,limit = 20000){
      if (!(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) || String(value).length > limit) throw new Error('В данных есть неподдерживаемое значение.');
      return String(value);
    }
    function plain(o){
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Неверный формат данных.');
      for (const key of Object.keys(o)) if (['__proto__','constructor','prototype'].includes(key)) throw new Error('Недопустимое имя поля в данных.');
      return o;
    }
    function panes(list){
      if (!Array.isArray(list) || list.length > 2000) throw new Error('В списке стёкол должно быть не больше 2000 строк.');
      return list.map(p => {
        plain(p);
        const q = text(p.q ?? '1',30), h = text(p.h ?? '',30), w = text(p.w ?? '',30);
        const number = s => Number(String(s).replace(',','.'));
        if (Math.abs(number(q)) > 10000 || Math.abs(number(h)) > 100000 || Math.abs(number(w)) > 100000) throw new Error('Слишком большое количество или размер стёкол.');
        return {n:text(p.n ?? '',300),h,w,q,bead:!!p.bead};
      });
    }
    function materials(list){
      if (!Array.isArray(list) || !list.length || list.length > 200) throw new Error('Неверный список материалов.');
      return list.map(m => {
        plain(m);
        return {id:text(m.id,100),name:text(m.name ?? '',500),rollPrice:text(m.rollPrice ?? '0',30),rollW:text(m.rollW ?? '1.52',30),rollL:text(m.rollL ?? '30',30),sell:text(m.sell ?? '0',30)};
      });
    }
    function settings(s){
      plain(s); const out = copy(defaults);
      if (!Array.isArray(s.panes)) throw new Error('В расчёте отсутствует список стёкол.');
      for (const key of Object.keys(defaults)) if (s[key] !== undefined){
        if (key === 'panes') out[key] = panes(s[key]);
        else if (key === 'materials') out[key] = materials(s[key]);
        else if (typeof defaults[key] === 'boolean'){
          if (typeof s[key] !== 'boolean') throw new Error('Неверное значение настройки.');
          out[key] = s[key];
        }else out[key] = text(s[key]);
      }
      return out;
    }
    function object(o){
      plain(o); if (!Array.isArray(o.panes)) throw new Error('В объекте отсутствуют стёкла.');
      const out = {};
      for (const key of objectFields) if (o[key] !== undefined) out[key] = key === 'panes' ? panes(o[key]) : text(o[key]);
      return out;
    }
    function order(o){
      plain(o);
      if (!['prelim','final'].includes(o.kind || 'prelim') || !Number.isFinite(Date.parse(o.date)) || !Number.isFinite(o.total) || !Number.isFinite(o.area)) throw new Error('Неверный формат документа.');
      return {kind:o.kind || 'prelim',no:text(o.no,200),date:text(o.date,100),name:text(o.name ?? '',500),client:text(o.client ?? '',500),total:o.total,area:o.area,snap:settings(o.snap)};
    }
    function snapshot(data){
      plain(data); plain(data.objects || {});
      if (!Array.isArray(data.orders) || data.orders.length > 5000 || Object.keys(data.objects || {}).length > 2000) throw new Error('Слишком много объектов или документов.');
      const objects = Object.create(null);
      for (const [name,o] of Object.entries(data.objects || {})) objects[text(name,500)] = object(o);
      return {settings:settings(data.settings),objects,orders:data.orders.map(order)};
    }
    function value(key,v){
      if (key === 'draft') settings(v);
      else if (key.startsWith('object:')){ if (['__proto__','constructor','prototype'].includes(key.slice(7))) throw new Error('Недопустимое имя объекта.'); object(v); }
      else if (key.startsWith('order:')) order(v);
      else throw new Error('Неизвестная запись.');
    }
    return {snapshot,value};
  }
  if (typeof module === 'object' && module.exports) module.exports = {createTools};
  else root.BronCloudData = {createTools};
})(typeof globalThis !== 'undefined' ? globalThis : this);

