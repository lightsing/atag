import { validateWorkspace } from './backup.ts';
import { emptyWorkspace, type WorkspaceData } from './types.ts';

export interface WorkspaceStore {
  read(): Promise<WorkspaceData>;
  update<T>(edit: (data: WorkspaceData) => T, signal?:AbortSignal): Promise<T>;
}

/** One atomic IndexedDB transaction for every mutation, also serializes tabs. No silent memory fallback. */
export class IndexedDbWorkspaceStore implements WorkspaceStore {
  #db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    return this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('浏览器存储不可用，未保存任何数据。请使用允许网站存储的浏览器。')); return; }
      const request = indexedDB.open('atag-browser-workspace', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(new Error('无法打开浏览器数据，未保存更改。'));
      request.onblocked = () => reject(new Error('其他标签页阻止打开数据，请关闭旧页面后重试。'));
    }).catch(error => { this.#db = null; throw error; });
  }
  async read(): Promise<WorkspaceData> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readonly');
      const request = tx.objectStore('workspace').get('current');
      tx.oncomplete = () => { try { resolve(validateWorkspace(request.result ?? emptyWorkspace())); } catch (error) { reject(error); } };
      tx.onabort = tx.onerror = () => reject(new Error('读取浏览器数据失败。'));
    });
  }
  async update<T>(edit: (data: WorkspaceData) => T, signal?:AbortSignal): Promise<T> {
    const db = await this.open();
    if(signal?.aborted)throw new DOMException('已取消','AbortError');
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite');
      const cancel=()=>{try{tx.abort();}catch{/* already completed */}};
      signal?.addEventListener('abort',cancel,{once:true});
      const table = tx.objectStore('workspace');
      const request = table.get('current');
      let result: T;
      let failure: unknown;
      request.onsuccess = () => {
        try { if(signal?.aborted)throw new DOMException('已取消','AbortError');const data = validateWorkspace(request.result ?? emptyWorkspace()); result = edit(data); table.put(data, 'current'); }
        catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => {signal?.removeEventListener('abort',cancel);resolve(result);};
      tx.onabort = tx.onerror = () => {signal?.removeEventListener('abort',cancel);reject(signal?.aborted?new DOMException('已取消','AbortError'):failure ?? new Error('浏览器数据写入失败（可能空间不足），更改未保存。'));};
    });
  }
}

/** Explicit test-only store. Production never falls back to it. */
export class MemoryWorkspaceStore implements WorkspaceStore {
  #data = emptyWorkspace();
  async read() { return structuredClone(this.#data); }
  async update<T>(edit: (data: WorkspaceData) => T, signal?:AbortSignal) {
    if(signal?.aborted)throw new DOMException('已取消','AbortError');const next = structuredClone(this.#data); const result = edit(next); this.#data = next; return result;
  }
}
