// Мини-хранилище ключ-значение поверх IndexedDB: чаты с Claude и кэш текстов статей.
const DB_NAME = 'krugozor';
const STORE = 'kv';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      console.warn('IndexedDB недоступна:', err);
      dbPromise = null;
      return null;
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kv = {
  get: (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined),
  set: (key, value) => tx('readwrite', (s) => s.put(value, key)).catch((e) => console.warn('kv.set', e)),
  del: (key) => tx('readwrite', (s) => s.delete(key)).catch(() => undefined),
  async keys(prefix = '') {
    const all = (await tx('readonly', (s) => s.getAllKeys()).catch(() => [])) || [];
    return all.filter((k) => typeof k === 'string' && k.startsWith(prefix));
  },
  async clear(prefix = '') {
    for (const k of await kv.keys(prefix)) await kv.del(k);
  },
};
