(function(){
  'use strict';
  const C = window.BronSyncCore, bridge = window.BronCloudBridge, tools = window.BronCloudData.createTools(bridge.defaults,bridge.objectFields);
  const CONFIG = 'glassbron-yandex-connection-v1', CLIENT_ID = '35fc3535b9134626af99c98891181719';
  const $ = id => document.getElementById(id), actor = crypto.randomUUID();
  let config = null, timer = null, running = false, generation = 0, epoch = 0, session = null, aborter = null;
  let doc = C.empty(), known = {}, previous = null, device = null, uploaded = null;
  const cache = new Map();
  const read = () => tools.snapshot(bridge.read());
  const status = text => { $('cloudStatus').textContent = text; };
  const storageKey = () => 'glassbron-cloud-data-v1:' + config.scope;
  const withLock = fn => {
    if (!navigator.locks) throw new Error('Для синхронизации нужен современный браузер с поддержкой блокировок вкладок.');
    return navigator.locks.request('glassbron-cloud-' + config.scope,fn);
  };
  function active(id){ return id === epoch && !!config; }
  function loadSession(){
    const raw = localStorage.getItem(storageKey());
    session = raw ? JSON.parse(raw) : {};
    device = session?.device || crypto.randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(device)) throw new Error('Повреждены локальные настройки синхронизации.');
    doc = session.doc ? C.validate(session.doc,tools.value) : C.empty();
    known = session?.known || {};
    previous = session?.previous ? tools.snapshot(session.previous) : null;
    cache.clear(); uploaded = null;
  }
  function mergeStored(){
    const raw = localStorage.getItem(storageKey());
    if (raw){ const stored = JSON.parse(raw); doc = C.merge(doc,C.validate(stored.doc,tools.value)); }
  }
  function persist(){
    localStorage.setItem(storageKey(),JSON.stringify({device,doc,known,previous}));
  }
  function capture(){
    if (!previous) return;
    const r = C.capture(doc,known,previous,read(),actor);
    doc = r.doc; known = r.known; previous = r.previous;
    persist();
  }
  function reflect(){
    if (bridge.editing()) return;
    const current = read(), next = tools.snapshot(C.materialize(doc,current));
    if (!C.equal(current,next)) bridge.apply(next);
    previous = read();
    for (const [key,reg] of Object.entries(doc.records)) if (C.uniqueVersions(reg).length === 1) known[key] = C.copy(reg);
    persist();
  }
  function showConnection(){
    $('cloudSetup').hidden = !!config;
    $('cloudActions').hidden = !config;
    $('cloudDisconnect').disabled = !config;
    $('cloudClient').value = config?.clientId || CLIENT_ID;
    $('cloudToken').value = '';
    authLink();
  }
  function authLink(){
    const id = $('cloudClient').value.trim();
    const valid = /^[a-f0-9]{32}$/i.test(id);
    $('cloudAuthorize').href = valid ? 'https://oauth.yandex.ru/authorize?response_type=token&client_id=' + id : 'https://oauth.yandex.ru/';
    $('cloudAuthorize').setAttribute('aria-disabled',String(!valid));
  }
  function describe(key,value){
    if (value === null) return 'Удаление записи';
    if (key === 'draft') return (value.name || 'Текущий расчёт') + ' · стёкол: ' + (value.panes?.length || 0) + ' · скидка: ' + (value.discountValue || '0') + (value.discountMode === 'rub' ? ' ₽' : '%');
    if (key.startsWith('object:')) return (value.client || value.name || key.slice(7)) + ' · стёкол: ' + (value.panes?.length || 0);
    return '№ ' + value.no + ' · ' + value.total + ' ₽ · ' + (value.client || value.name || 'Документ');
  }
  function download(data,name){
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  function renderConflicts(){
    const panel = $('cloudConflicts'); panel.replaceChildren();
    const list = C.conflicts(doc); panel.hidden = !list.length;
    if (!list.length) return;
    const heading = document.createElement('p'); heading.textContent = 'Есть разные версии. Они сохранены обе. Выберите, какую использовать:'; panel.append(heading);
    for (const item of list){
      const section = document.createElement('div'); section.className = 'cloud-conflict';
      const title = document.createElement('b'); title.textContent = item.key === 'draft' ? 'Текущий расчёт и настройки' : item.key.startsWith('object:') ? 'Объект: ' + item.key.slice(7) : 'Документ'; section.append(title);
      for (const version of item.versions){
        const row = document.createElement('div'), text = document.createElement('span'), use = document.createElement('button');
        text.textContent = describe(item.key,version.value) + ' · ' + new Date(version.at).toLocaleString('ru-RU');
        use.textContent = 'Использовать эту версию';
        use.addEventListener('click',() => resolve(item.key,version));
        row.append(text,use); section.append(row);
      }
      const backup = document.createElement('button'); backup.textContent = 'Скачать обе версии';
      backup.addEventListener('click',() => download({app:'glassbron-conflict',key:item.key,versions:item.versions},'bron-conflict.json'));
      section.append(backup); panel.append(section);
    }
  }
  async function resolve(key,version){
    const id = epoch;
    try{
      await withLock(async () => {
        if (!active(id)) return;
        mergeStored(); capture();
        const reg = doc.records[key];
        if (!reg?.versions.some(v => v.actor === version.actor && v.seq === version.seq)) throw new Error('Версии изменились. Обновите синхронизацию перед выбором.');
        // The other version is retained locally as a recovery copy before an explicit choice.
        localStorage.setItem('glassbron-cloud-last-conflict:' + config.scope,JSON.stringify({key,reg}));
        doc.records[key] = C.edit(reg,actor,version.value); known[key] = C.copy(doc.records[key]);
        reflect();
        generation++; renderConflicts();
      });
      if (active(id)) schedule(0);
    }catch(e){ status(e.message); }
  }
  function schedule(delay = 1800){
    clearTimeout(timer);
    if (config) timer = setTimeout(sync,delay);
  }
  function changed(){
    if (!config) return;
    generation++; status('Есть изменения на устройстве. Ожидаю синхронизацию…'); schedule();
  }
  async function sync(){
    if (!config || running) return;
    if (!navigator.onLine){ status('Нет интернета. Изменения сохранены на устройстве.'); return; }
    const id = epoch; running = true; $('cloudNow').disabled = true;
    status('Синхронизация с Яндекс Диском…');
    try{
      await withLock(async () => {
        if (!active(id)) return;
        mergeStored(); capture();
        const files = await session.disk.list();
        if (!active(id)) return;
        let remote = C.empty(), serverOwn = null;
        for (const file of files){
          let entry = cache.get(file.name);
          if (!entry || !file.md5 || entry.md5 !== file.md5){
            entry = {md5:file.md5,doc:C.validate(await session.disk.download(file.name),tools.value)};
            if (!active(id)) return;
            cache.set(file.name,entry);
          }
          remote = C.merge(remote,entry.doc);
          if (file.name === 'device-' + device + '.json') serverOwn = C.stable(C.merge(C.empty(),entry.doc));
        }
        // A fresh device takes cloud data. An existing local dataset becomes its own version.
        if (!previous){
          const local = read();
          if (bridge.hasLocalData() || !Object.keys(remote.records).length){
            previous = {settings:local.settings,objects:{},orders:[]}; known = {};
            const captured = C.capture(C.empty(),known,previous,local,actor);
            doc = C.merge(doc,captured.doc); known = captured.known;
          }
          previous = local;
        }
        doc = C.merge(doc,remote); capture(); persist(); renderConflicts();
        const serial = C.stable(doc), writtenGeneration = generation;
        if (serial !== serverOwn){
          await session.disk.upload('device-' + device + '.json',doc);
          if (!active(id)) return;
          uploaded = serial;
        }else uploaded = serial;
        capture(); reflect(); renderConflicts();
        const pending = generation !== writtenGeneration || C.stable(doc) !== uploaded;
        const deferred = bridge.editing() && !C.equal(read(),tools.snapshot(C.materialize(doc,read())));
        const n = C.conflicts(doc).length;
        status(pending ? 'Новые изменения сохранены на устройстве. Отправляю…' : n ? `Синхронизировано. Нужно выбрать версии: ${n}.` : deferred ? 'Данные Диска получены. Уберите курсор из поля, чтобы обновить расчёт.' : 'Синхронизировано · ' + new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}));
        if (pending) schedule(1800);
      });
    }catch(e){
      if (active(id)) status(e instanceof TypeError || e.name === 'AbortError' ? 'Не удалось связаться с Яндекс Диском. Данные остаются на устройстве; повторим позже.' : e.message);
    }finally{
      running = false; $('cloudNow').disabled = false;
    }
  }
  async function activate(saved){
    if (!navigator.locks) throw new Error('Обновите браузер: для безопасной синхронизации нужна поддержка блокировок вкладок.');
    epoch++; aborter?.abort(); aborter = new AbortController();
    config = saved;
    const disk = new window.BronDisk.YandexDisk(config.token,{signal:aborter.signal});
    await withLock(async () => { loadSession(); persist(); });
    session.disk = disk;
    showConnection(); renderConflicts(); schedule(0);
  }
  $('cloudClient').addEventListener('input',authLink);
  $('cloudConnect').addEventListener('click',async () => {
    if (config) return;
    const clientId = $('cloudClient').value.trim(), token = $('cloudToken').value.trim();
    if (!/^[a-f0-9]{32}$/i.test(clientId) || !/^[a-zA-Z0-9_.-]{20,512}$/.test(token)) { status('Укажите ClientID и токен, полученный на странице Яндекса.'); return; }
    $('cloudConnect').disabled = true;
    try{
      status('Проверяю доступ к папке приложения…');
      const disk = new window.BronDisk.YandexDisk(token), resource = await disk.prepare();
      const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(clientId + ':' + resource));
      const scope = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2,'0')).join('');
      const saved = {clientId,token,scope}; localStorage.setItem(CONFIG,JSON.stringify(saved));
      await activate(saved);
    }catch(e){
      epoch++; aborter?.abort(); config = null; session = null; localStorage.removeItem(CONFIG); showConnection();
      status(e instanceof TypeError ? 'Не удалось подключиться к Яндексу. Проверьте интернет и разрешение на папку приложения.' : e.name === 'QuotaExceededError' ? 'Не хватает памяти браузера. Выгрузите резервную копию данных.' : e.message);
    }
    finally{ $('cloudConnect').disabled = false; }
  });
  $('cloudNow').addEventListener('click',() => { clearTimeout(timer); sync(); });
  $('cloudDisconnect').addEventListener('click',() => {
    if (!confirm('Отключить Яндекс Диск на этом устройстве? Местные данные и файлы на Диске сохранятся.')) return;
    epoch++; aborter?.abort(); clearTimeout(timer); config = null; session = null; cache.clear();
    localStorage.removeItem(CONFIG); showConnection(); $('cloudConflicts').replaceChildren(); $('cloudConflicts').hidden = true;
    status('Яндекс Диск отключён на этом устройстве. Данные сохранены.');
  });
  window.bronCloud = {changed,syncNow:sync};
  window.addEventListener('online',() => schedule(0));
  window.addEventListener('focus',() => schedule(300));
  document.addEventListener('focusout',() => schedule(400));
  document.addEventListener('visibilitychange',() => { if (!document.hidden) schedule(0); });
  window.addEventListener('storage',event => {
    if (event.key === CONFIG){ location.reload(); return; }
    if (config && event.key === storageKey()){
      try{ if (!C.equal(JSON.parse(event.newValue).doc,doc)) schedule(500); }catch(_){}
    }
  });
  setInterval(() => { if (!document.hidden) schedule(0); },30000);
  showConnection();
  try{
    const raw = localStorage.getItem(CONFIG);
    if (raw){
      const saved = JSON.parse(raw);
      if (!saved || !/^[a-f0-9]{32}$/i.test(saved.clientId) || !/^[a-f0-9]{64}$/.test(saved.scope) || typeof saved.token !== 'string') throw new Error('Подключите Яндекс Диск заново.');
      activate(saved).catch(e => { config = null; showConnection(); status(e.message); });
    }
  }catch(e){ status(e.message); }
})();

