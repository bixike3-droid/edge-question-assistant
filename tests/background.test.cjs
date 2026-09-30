const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
globalThis.crypto ||= require("node:crypto").webcrypto;
test("keyboard command opens sidebar synchronously, then queues the exact tab for cold startup",async()=>{
  let callback,finishOpen;const calls=[],writes=[];
  const chrome={
    runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}}},
    commands:{onCommand:{addListener(fn){callback=fn}}},
    sidePanel:{open(options){calls.push(options);return new Promise(resolve=>finishOpen=resolve)}},
    storage:{session:{async set(value){writes.push(value)}}}
  };
  vm.runInNewContext(fs.readFileSync(require("node:path").join(__dirname,"../background.js"),"utf8"),{chrome,crypto,Date,console});
  callback("other",{id:5,windowId:7});callback("capture-question",null);assert.equal(calls.length,0);
  callback("capture-question",{id:5,windowId:7});
  assert.equal(calls.length,1);assert.equal(calls[0].windowId,7);assert.equal(writes.length,0);
  finishOpen();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes[0]["captureShortcut:7"].tabId,5);assert.equal(writes[0]["captureShortcut:7"].windowId,7);
});
