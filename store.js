"use strict";
(() => {
  let database;
  async function open() {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("question-sidebar-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("conversations", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("无法打开本地记录，请检查 Edge 的存储设置。"));
    });
    database.onversionchange = () => { database.close(); database = null; };
    return database;
  }
  async function transaction(write, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("conversations", write ? "readwrite" : "readonly");
      let result;
      try { operation(tx.objectStore("conversations"), (value) => { result = value; }); }
      catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(new Error("本地记录保存失败，请先导出备份并检查磁盘空间。"));
      tx.onerror = () => reject(new Error("本地记录保存失败，请先导出备份并检查磁盘空间。"));
    });
  }
  globalThis.QuestionStore = {
    open,
    all: () => transaction(false, (store, done) => { store.getAll().onsuccess = (event) => done(event.target.result); }),
    put: (value) => { const snapshot = structuredClone(value); return transaction(true, (store) => store.put(snapshot)); },
    remove: (id) => transaction(true, (store) => store.delete(id)),
    clear: () => transaction(true, (store) => store.clear()),
    putMany: (values) => { const snapshots = structuredClone(values); return transaction(true, (store) => { for (const value of snapshots) store.put(value); }); }
  };
})();
