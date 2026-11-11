/* Yandex Disk transport. Tokens go only to cloud-api.yandex.net, never to file URLs. */
(function(root){
  'use strict';
  const API = 'https://cloud-api.yandex.net/v1/disk';
  const FOLDER = 'app:/GlassBRON-sync-v1';
  class DiskError extends Error {
    constructor(status){
      super(status === 401 ? 'Доступ истёк. Подключите Яндекс Диск заново.' : status === 403 ? 'Нет доступа к папке приложения. Проверьте разрешение в Яндексе.' : status === 429 ? 'Яндекс просит подождать. Повторите синхронизацию позже.' : status === 507 ? 'На Яндекс Диске закончилось место.' : `Яндекс Диск недоступен (код ${status}). Данные остаются на устройстве.`);
      this.status = status;
    }
  }
  class YandexDisk {
    constructor(token, options = {}){ this.token = token; this.fetch = options.fetch || root.fetch.bind(root); this.signal = options.signal; this.pause = options.pause || (ms => new Promise(r => setTimeout(r,ms))); }
    async request(url,options = {}){
      const controller = new AbortController(), abort = () => controller.abort();
      if (this.signal?.aborted) controller.abort();
      this.signal?.addEventListener('abort',abort,{once:true});
      const timer = setTimeout(abort,25000);
      try{
        const response = await this.fetch(url,{credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',...options,signal:controller.signal});
        if (!response.ok) throw new DiskError(response.status);
        return response;
      }finally{ clearTimeout(timer); this.signal?.removeEventListener('abort',abort); }
    }
    async api(endpoint,params = {},method = 'GET'){
      const url = API + endpoint + '?' + new URLSearchParams(params);
      const r = await this.request(url,{method,headers:{Authorization:'OAuth ' + this.token,Accept:'application/json'}});
      if (r.status === 204) return {};
      return r.json();
    }
    signedURL(href){
      const u = new URL(href);
      if (u.protocol !== 'https:' || u.username || u.password || !['yandex.ru','yandex.net','yandex.com'].some(h => u.hostname.endsWith('.' + h))) throw new Error('Яндекс вернул неподдерживаемый адрес файла.');
      return u.href;
    }
    async prepare(){
      const rootInfo = await this.api('/resources',{path:'app:/',fields:'resource_id,type'});
      if (!rootInfo.resource_id || rootInfo.type !== 'dir') throw new Error('Не удалось определить папку приложения на Диске.');
      try{ await this.api('/resources',{path:FOLDER},'PUT'); }
      catch(e){ if (e.status !== 409) throw e; }
      const folder = await this.api('/resources',{path:FOLDER,fields:'type'});
      if (folder.type !== 'dir') throw new Error('Вместо папки синхронизации на Диске находится файл.');
      return rootInfo.resource_id;
    }
    async list(){
      const files = []; let offset = 0;
      for (;;){
        const page = await this.api('/resources',{path:FOLDER,limit:'100',offset:String(offset),sort:'name',fields:'_embedded.items.name,_embedded.items.md5,_embedded.items.type,_embedded.total'});
        const data = page._embedded;
        if (!data || !Array.isArray(data.items)) throw new Error('Яндекс вернул неполный список файлов.');
        files.push(...data.items.filter(f => f.type === 'file' && /^device-[a-f0-9-]{36}\.json$/.test(f.name)));
        offset += data.items.length;
        if (offset >= data.total) return files;
        if (!data.items.length || offset > 10000) throw new Error('Слишком много файлов в папке синхронизации.');
      }
    }
    async download(name){
      if (!/^device-[a-f0-9-]{36}\.json$/.test(name)) throw new Error('Неверное имя файла синхронизации.');
      const link = await this.api('/resources/download',{path:FOLDER + '/' + name});
      const response = await this.request(this.signedURL(link.href),{redirect:'follow'});
      if (Number(response.headers.get('content-length') || 0) > 5 * 1024 * 1024) throw new Error('Файл синхронизации слишком большой.');
      const text = await response.text();
      if (text.length > 5 * 1024 * 1024) throw new Error('Файл синхронизации слишком большой.');
      return JSON.parse(text);
    }
    async upload(name,doc){
      if (!/^device-[a-f0-9-]{36}\.json$/.test(name)) throw new Error('Неверное имя файла синхронизации.');
      const writeId = root.crypto.randomUUID(), payload = {...doc,writeId}, text = JSON.stringify(payload);
      if (text.length > 5 * 1024 * 1024) throw new Error('Данные синхронизации превышают 5 МБ. Выгрузите резервную копию.');
      const link = await this.api('/resources/upload',{path:FOLDER + '/' + name,overwrite:'true'});
      await this.request(this.signedURL(link.href),{method:'PUT',headers:{'Content-Type':'application/json'},body:text});
      // PUT may return 202 before the new version is available. Verify before reporting success.
      for (let attempt = 0; attempt < 4; attempt++){
        try{ if ((await this.download(name)).writeId === writeId) return; }
        catch(e){ if (e.status !== 404) throw e; }
        await this.pause(700 * (attempt + 1));
      }
      throw new Error('Яндекс ещё обрабатывает файл. Повторим синхронизацию; данные сохранены на устройстве.');
    }
  }
  const api = {YandexDisk,DiskError,FOLDER};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BronDisk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

