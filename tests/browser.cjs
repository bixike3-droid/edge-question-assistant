const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),https=require("node:https"),{execFileSync}=require("node:child_process"),{pathToFileURL}=require("node:url");
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||"playwright");
const root=process.env.EXTENSION_ROOT?path.resolve(process.env.EXTENSION_ROOT):path.resolve(__dirname,".."),out=path.resolve(__dirname,"../.qa");
fs.mkdirSync(out,{recursive:true});
const openssl=process.env.OPENSSL_BINARY||(process.platform==="win32"?"C:/Program Files/Git/usr/bin/openssl.exe":"openssl");
execFileSync(openssl,["req","-x509","-newkey","rsa:2048","-nodes","-days","2","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost,IP:127.0.0.1","-keyout",path.join(out,"test.key"),"-out",path.join(out,"test.crt")],{stdio:"pipe"});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"question-extension-test-"));
function pdf() {
  const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream="0 .3 .9 rg 50 610 480 120 re f 0 0 0 rg BT /F1 24 Tf 65 670 Td (PDF QUESTION: x + 1 = 2) Tj ET";
  objects.push("<< /Length "+Buffer.byteLength(stream)+" >>\nstream\n"+stream+"\nendstream");
  let data="%PDF-1.4\n",offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(data));data+=(i+1)+" 0 obj\n"+o+"\nendobj\n"});
  const xref=Buffer.byteLength(data);data+="xref\n0 6\n0000000000 65535 f \n"+offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")+"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"+xref+"\n%%EOF";
  return Buffer.from(data);
}
const server=https.createServer({key:fs.readFileSync(path.join(out,"test.key")),cert:fs.readFileSync(path.join(out,"test.crt"))},(req,res)=>{
  if(req.url.startsWith("/question.pdf")){res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition","inline");res.end(pdf());return}
  res.setHeader("Content-Type","text/html;charset=utf-8");
  if(req.url.startsWith("/black")){res.end('<body style="margin:0;background:#000;overflow:hidden;height:100vh"></body>');return}
  res.end('<!doctype html><html><head><meta charset="utf-8"><title>Fixture question</title></head><body style="margin:0;background:white;min-height:1600px;font-family:Arial"><div id="question" style="position:absolute;left:90px;top:120px;width:460px;height:210px;background:#fff;border:2px solid #111;padding:20px;box-sizing:border-box"><span style="display:block;background:#18aa44;height:30px;width:390px"></span><h2>Question 3: x + 1 = 2</h2><p>Find x and show necessary working.</p></div></body></html>');
});
let context,apiMode="success",requests=[],errors=[];
const log=(name)=>console.log("PASS: "+name);
async function waitIdle(panel){await panel.waitForFunction(()=>state.ready&&!state.running&&!state.assetBusy&&!state.submitting)}
async function screenshot(panel,name){await panel.screenshot({path:path.join(out,name+".png")})}
(async()=>{
  await new Promise(r=>server.listen(0,"127.0.0.1",r));const base="https://127.0.0.1:"+server.address().port;
  context=await chromium.launchPersistentContext(profile,{executablePath:process.env.EDGE_EXECUTABLE||"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",headless:process.env.HEADLESS==="true",ignoreDefaultArgs:["--disable-extensions","--disable-component-extensions-with-background-pages"],args:["--enable-unsafe-extension-debugging","--window-position=-10000,-10000"],acceptDownloads:true,ignoreHTTPSErrors:true,viewport:{width:390,height:850}});
  await context.route("https://api.deepseek.com/**",async route=>{
    const req=route.request(),auth=req.headers().authorization;
    if(req.url().endsWith("/models")){
      await route.fulfill({status:auth==="Bearer test-invalid"?401:200,contentType:"application/json",body:JSON.stringify(auth==="Bearer test-invalid"?{error:{message:"wrong key"}}:{data:[{id:"deepseek-flash"}]})});return
    }
    const body=JSON.parse(req.postData());requests.push(body);
    if(apiMode==="402"){await route.fulfill({status:402,contentType:"application/json",body:JSON.stringify({error:{message:"balance"}})});return}
    const content="先整理方程：\n\n$$x+1=2$$\n\n因此 $x=1$。";
    const data="data: "+JSON.stringify({choices:[{delta:{content}}]})+"\n\n"+(apiMode==="truncated"?"":"data: [DONE]\n\n");
    await new Promise(r=>setTimeout(r,100));await route.fulfill({status:200,contentType:"text/event-stream",body:data});
  });
  const cdp=await context.browser().newBrowserCDPSession();const {id}=await cdp.send("Extensions.loadUnpacked",{path:root});
  const worker=context.serviceWorkers().find(w=>w.url().startsWith("chrome-extension://"+id+"/"))||await context.waitForEvent("serviceworker",{predicate:w=>w.url().startsWith("chrome-extension://"+id+"/")});
  assert.equal(await worker.evaluate(()=>chrome.runtime.getManifest().side_panel.default_path),"sidepanel.html");
  assert.equal((await worker.evaluate(()=>chrome.commands.getAll())).find(c=>c.name==="capture-question").shortcut,"Alt+Shift+S");
  let panel=await context.newPage();panel.on("pageerror",e=>errors.push(e.message));await panel.goto("chrome-extension://"+id+"/sidepanel.html");await waitIdle(panel);
  assert(await panel.locator("#promptInput").isEnabled());assert(await panel.locator("#sendButton").isDisabled());await screenshot(panel,"empty");log("real unpacked Edge extension loads with sidebar and shortcut configuration");
  await panel.getByRole("button",{name:"设置",exact:true}).click();await panel.locator("#apiKeyInput").fill("test-invalid");await panel.locator("#checkConnectionButton").click();await panel.waitForFunction(()=>!state.checkAbort);
  assert((await panel.locator("#apiConnectionStatus").textContent()).includes("无效"));assert.equal(await panel.evaluate(()=>state.key),"");
  await panel.locator("#apiKeyInput").fill("test-key");await panel.locator("#checkConnectionButton").click();await panel.waitForFunction(()=>!state.checkAbort);assert((await panel.locator("#apiConnectionStatus").textContent()).includes("连接正常"));
  await panel.getByRole("button",{name:"保存设置",exact:true}).click();await panel.locator("#chatView.active").waitFor();log("connection detection distinguishes invalid and valid Keys and saving stays explicit");

  const sources=await panel.evaluate(()=>["#dd6666","#66bb88","#7799dd","#ddbb66"].map((color,i)=>{const c=document.createElement("canvas");c.width=1200;c.height=460;const x=c.getContext("2d");x.fillStyle=color;x.fillRect(0,0,1200,460);x.fillStyle="#111";x.font="48px sans-serif";x.fillText("Question image "+(i+1),80,150);return c.toDataURL("image/png")}));
  const file=(i)=>({name:"question-"+i+".png",mimeType:"image/png",buffer:Buffer.from(sources[i].split(",")[1],"base64")});
  await panel.locator("#imageFileInput").setInputFiles([file(0),file(1)]);await waitIdle(panel);assert.equal(await panel.locator(".attachment-card").count(),2);
  await panel.evaluate(src=>{const binary=atob(src.split(",")[1]),data=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)data[i]=binary.charCodeAt(i);const dt=new DataTransfer();dt.items.add(new File([data],"paste.png",{type:"image/png"}));document.dispatchEvent(new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true}))},sources[2]);
  await panel.waitForFunction(()=>state.pendingImages.length===3&&!state.assetBusy);
  await panel.evaluate(src=>{const binary=atob(src.split(",")[1]),data=Uint8Array.from(binary,c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([data],"drop.png",{type:"image/png"}));document.getElementById("composeForm").dispatchEvent(new DragEvent("drop",{dataTransfer:dt,bubbles:true,cancelable:true}))},sources[3]);
  await panel.waitForFunction(()=>state.pendingImages.length===4&&!state.assetBusy);
  const originalOrder=await panel.evaluate(()=>[...state.pendingImages]);
  await panel.getByRole("button",{name:"将第 2 张图片前移",exact:true}).click();await panel.waitForFunction(first=>state.pendingImages[0]===first,originalOrder[1]);
  await panel.locator(".attachment-card").nth(0).dragTo(panel.locator(".attachment-card").nth(2));await panel.waitForFunction(first=>state.pendingImages[2]===first,originalOrder[1]);
  await panel.locator("#imageFileInput").setInputFiles([file(0)]);await waitIdle(panel);assert.equal(await panel.locator(".attachment-card").count(),4);assert((await panel.locator("#status").textContent()).includes("4 张"));
  await panel.locator(".attachment-preview").first().click();assert.equal(await panel.locator("#previewCount").textContent(),"1 / 4");await panel.locator("#nextImageButton").click();assert.equal(await panel.locator("#previewCount").textContent(),"2 / 4");
  await panel.locator("#previewZoom").selectOption("1");assert.equal(await panel.locator("#fullPreviewImage").evaluate(i=>i.style.width),"1200px");await screenshot(panel,"preview");
  await panel.keyboard.press("Escape");await panel.locator("#chatView.active").waitFor();await panel.getByRole("button",{name:"移除第 4 张图片",exact:true}).click();assert.equal(await panel.locator(".attachment-card").count(),3);
  await panel.getByRole("button",{name:"清空图片",exact:true}).click();await panel.waitForFunction(()=>state.pendingImages.length===0);log("upload, paste, drop, multi-image limits, drag/keyboard reorder, preview zoom and removal");

  const question=await context.newPage();await question.goto(base+"/question");await question.bringToFront();
  const target=await panel.evaluate(async url=>{const [t]=await chrome.tabs.query({url});return{tabId:t.id,windowId:t.windowId,url:t.url}},question.url());
  const viewport=await question.evaluate(()=>({width:innerWidth,height:innerHeight}));
  const bitmap=await panel.evaluate(async t=>{const src=await chrome.tabs.captureVisibleTab(t.windowId,{format:"png"});const image=await loadImage(src);return{width:image.width,height:image.height}},target);
  await panel.evaluate(t=>selectOnPage(t),target);await question.locator("[data-question-selection]").waitFor();await question.mouse.move(92,122);await question.mouse.down();await question.mouse.move(360,330,{steps:10});await question.mouse.up();
  await panel.waitForFunction(()=>state.pendingImages.length===1&&!state.assetBusy);
  const dimensions=await panel.evaluate(async()=>{const image=await loadImage(state.pendingImages[0]);return {width:image.width,height:image.height,active:document.activeElement.id}});
  assert.equal(dimensions.width,Math.ceil(360*bitmap.width/viewport.width)-Math.floor(92*bitmap.width/viewport.width));assert.equal(dimensions.height,Math.ceil(330*bitmap.height/viewport.height)-Math.floor(122*bitmap.height/viewport.height));assert.equal(dimensions.active,"promptInput");
  const pixels=await panel.evaluate(async()=>{const image=await loadImage(state.pendingImages[0]),c=document.createElement("canvas");c.width=image.width;c.height=image.height;const x=c.getContext("2d");x.drawImage(image,0,0);return [...x.getImageData(35,35,1,1).data]});assert(pixels[1]>pixels[0]&&pixels[1]>pixels[2]);
  await question.bringToFront();await panel.evaluate(t=>selectOnPage(t),target);await question.locator("[data-question-selection]").waitFor();await question.keyboard.press("Escape");await panel.waitForFunction(()=>!state.selection);assert.equal(await question.locator("[data-question-selection]").count(),0);
  await panel.bringToFront();await panel.locator("#imageFileInput").setInputFiles([file(0),file(1)]);await waitIdle(panel);await panel.locator("#promptInput").fill("求第 3 小题");await panel.locator("#modeSelect").selectOption("concise");
  await panel.reload();await waitIdle(panel);assert.equal(await panel.locator("#promptInput").inputValue(),"求第 3 小题");assert.equal(await panel.locator(".attachment-card").count(),3);assert.equal(await panel.locator("#modeSelect").inputValue(),"concise");log("real page rectangle capture, correct pixels and dimensions, overlay cancellation, automatic focus and draft reload");

  const draftConversationId=await panel.evaluate(()=>state.current.id);
  await panel.getByRole("button",{name:"新对话",exact:true}).click();await panel.waitForFunction(id=>state.current.id!==id,draftConversationId);await waitIdle(panel);assert.equal(await panel.locator(".attachment-card").count(),0);
  await panel.getByRole("button",{name:"历史对话",exact:true}).click();await panel.locator('.history-item[data-conversation-id="'+draftConversationId+'"] .history-open').click();await waitIdle(panel);assert.equal(await panel.locator("#promptInput").inputValue(),"求第 3 小题");assert.equal(await panel.locator(".attachment-card").count(),3);assert.equal(await panel.locator("#modeSelect").inputValue(),"concise");log("new conversation and switching back preserve draft images, text and mode");
  await panel.evaluate(()=>{sendMessage();sendMessage()});await waitIdle(panel);assert.equal(requests.length,1);assert.equal(requests[0].messages.at(-1).content.filter(p=>p.type==="image_url").length,3);
  assert(requests[0].messages[0].content.includes("选择题仅给"));assert(await panel.locator(".katex").count()>0);
  const originalId=await panel.evaluate(()=>state.current.id),originalMessages=await panel.evaluate(()=>JSON.stringify(state.current.messages));
  await panel.getByRole("button",{name:"复制回答",exact:true}).last().click();await panel.waitForFunction(()=>document.getElementById("status").textContent.includes("回答已复制"));await context.grantPermissions(["clipboard-read","clipboard-write"]);assert((await panel.evaluate(()=>navigator.clipboard.readText())).includes("x=1"));
  const markdownDownload=panel.waitForEvent("download");await panel.locator("#exportButton").click();await panel.locator("#exportMarkdownButton").click();const md=await markdownDownload;const mdPath=path.join(out,"conversation.md");await md.saveAs(mdPath);assert(fs.readFileSync(mdPath,"utf8").includes("x=1"));assert(!fs.readFileSync(mdPath,"utf8").includes("test-key"));await panel.locator("#exportView [data-back]").click();log("Markdown export preserves formula source and contains no saved API Key");
  await screenshot(panel,"chat");await panel.locator("#promptInput").fill("尚未发送的下一题");await panel.getByRole("button",{name:"修改提问",exact:true}).first().click();await panel.locator("#editBanner").waitFor({state:"visible"});
  await panel.locator("#promptInput").fill("取消的修改");await panel.locator("#cancelEditButton").click();assert.equal(await panel.locator("#promptInput").inputValue(),"尚未发送的下一题");
  await panel.getByRole("button",{name:"修改提问",exact:true}).first().click();await panel.locator("#editBanner").waitFor({state:"visible"});await panel.locator("#promptInput").fill("改为求第 2 小题");await panel.locator("#sendButton").click();await waitIdle(panel);
  assert.notEqual(await panel.evaluate(()=>state.current.id),originalId);assert.equal(await panel.evaluate(id=>JSON.stringify(state.conversations.find(c=>c.id===id).messages),originalId),originalMessages);
  assert.equal(requests[1].messages.at(-1).content[0].text,"改为求第 2 小题");const editedId=await panel.evaluate(()=>state.current.id);
  await panel.getByRole("button",{name:"重新回答",exact:true}).last().click();await waitIdle(panel);assert.notEqual(await panel.evaluate(()=>state.current.id),editedId);assert.equal(await panel.evaluate(id=>state.conversations.find(c=>c.id===id).messages.length,editedId),2);
  log("single submission, all images in request, math rendering, real clipboard copy, edit cancellation and history-preserving edit/regenerate");

  apiMode="truncated";await panel.locator("#promptInput").fill("连接中断测试");await panel.locator("#sendButton").click();await waitIdle(panel);
  assert.equal(await panel.evaluate(()=>state.current.messages.at(-1).status),"error");assert((await panel.evaluate(()=>state.current.messages.at(-1).content)).includes("x=1"));
  apiMode="402";await panel.locator("#promptInput").fill("余额提示测试");await panel.locator("#sendButton").click();await waitIdle(panel);assert((await panel.locator("#status").textContent()).includes("额度不足"));apiMode="success";
  await panel.evaluate(()=>{window.__originalStream=Api.stream;Api.stream=(key,messages,onDelta,signal)=>window.__originalStream(key,messages,onDelta,signal,{fetcher:async(url,options)=>new Response(new ReadableStream({start(controller){window.__streamController=controller;controller.enqueue(new TextEncoder().encode("data: "+JSON.stringify({choices:[{delta:{content:("已收到的分步解答。\n\n").repeat(80)}}]})+"\n\n"));options.signal.addEventListener("abort",()=>controller.error(new DOMException("stop","AbortError")))} }))})});
  await panel.locator("#promptInput").fill("停止生成测试");await panel.locator("#sendButton").click();await panel.waitForFunction(()=>state.running&&state.current.messages.at(-1).content.length>100);
  await panel.locator("#messages").evaluate(e=>e.scrollTop=0);await panel.evaluate(()=>window.__streamController.enqueue(new TextEncoder().encode("data: "+JSON.stringify({choices:[{delta:{content:"仍在继续。"}}]})+"\n\n")));await panel.waitForTimeout(180);assert.equal(await panel.locator("#messages").evaluate(e=>e.scrollTop),0);assert(await panel.locator("#jumpBottomButton").isVisible());
  await panel.locator("#stopButton").click();await waitIdle(panel);assert.equal(await panel.evaluate(()=>state.current.messages.at(-1).status),"stopped");assert((await panel.evaluate(()=>state.current.messages.at(-1).content)).includes("已收到"));
  await panel.evaluate(()=>{Api.stream=window.__originalStream});log("actionable balance errors, retained interrupted content, actual abort of partial stream and reading without forced scroll");

  await panel.getByRole("button",{name:"历史对话",exact:true}).click();await panel.locator("#historySearch").fill("改为求第 2");assert(await panel.locator(".history-item").count()>0);await panel.locator("#historySearch").fill("zzzz-no-match");assert.equal(await panel.locator(".history-item").count(),0);await panel.locator("#historySearch").fill("");
  await panel.locator(".history-rename").first().click();await panel.locator(".history-title-input").fill("我的练习");await panel.locator(".history-title-input").press("Enter");await panel.getByRole("button",{name:/我的练习/}).first().click();await waitIdle(panel);
  await panel.locator("#promptInput").fill("备份中的草稿");await panel.locator("#modeSelect").selectOption("check");await panel.getByRole("button",{name:"设置",exact:true}).click();
  const dlPromise=panel.waitForEvent("download");await panel.locator("#backupAllButton").click();const download=await dlPromise,backupPath=path.join(out,"backup.json");await download.saveAs(backupPath);
  const backupText=fs.readFileSync(backupPath,"utf8"),backup=JSON.parse(backupText);assert(!backupText.includes("test-key"));assert(backup.conversations.some(c=>c.draftText==="备份中的草稿"&&c.mode==="check"));assert(backup.conversations.some(c=>c.messages.some(m=>m.images?.length===3)));
  const countBefore=await panel.evaluate(()=>state.conversations.length);await panel.locator("#clearHistoryButton").click();await panel.locator("#cancelConfirmButton").click();assert.equal(await panel.evaluate(()=>state.conversations.length),countBefore);
  await panel.locator("#clearHistoryButton").click();await panel.locator("#confirmActionButton").click();await waitIdle(panel);assert.equal(await panel.evaluate(()=>state.conversations.length),1);assert.equal(await panel.evaluate(()=>state.key),"test-key");
  await panel.locator("#backupFileInput").setInputFiles(backupPath);await panel.locator("#restoreView.active").waitFor();await screenshot(panel,"restore");assert.equal(await panel.evaluate(()=>state.conversations.length),1);
  await panel.locator("#confirmRestoreButton").click();await waitIdle(panel);assert.equal(await panel.evaluate(()=>state.conversations.length),countBefore+1);assert(await panel.locator(".history-open").first().isEnabled());
  await panel.getByRole("button",{name:"设置",exact:true}).click();await panel.locator("#backupFileInput").setInputFiles(backupPath);await panel.locator("#restoreView.active").waitFor();assert(await panel.locator("#confirmRestoreButton").isDisabled());
  await panel.getByRole("button",{name:"取消",exact:true}).click();
  await panel.locator("#backupFileInput").setInputFiles({name:"bad.json",mimeType:"application/json",buffer:Buffer.from("{invalid}")});await panel.waitForFunction(()=>!state.assetBusy);assert((await panel.locator("#status").textContent()).includes("有效的 JSON"));assert.equal(await panel.evaluate(()=>state.conversations.length),countBefore+1);
  const damaged=JSON.parse(backupText);damaged.conversations[0].id="damaged-new";damaged.conversations[0].draftImages=["data:image/png;base64,iVBORw0KGgo="];
  await panel.locator("#backupFileInput").setInputFiles({name:"damaged.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(damaged))});await panel.waitForFunction(()=>!state.assetBusy);assert((await panel.locator("#status").textContent()).includes("损坏"));assert.equal(await panel.evaluate(()=>state.conversations.length),countBefore+1);
  await panel.getByRole("button",{name:"历史对话",exact:true}).click();const deletingId=await panel.evaluate(()=>state.current.id);const deletingRow=panel.locator('.history-item[data-conversation-id="'+deletingId+'"]');const beforeDelete=await panel.evaluate(()=>state.conversations.length);await deletingRow.locator(".history-delete").click();await panel.locator("#cancelConfirmButton").click();assert.equal(await panel.evaluate(()=>state.conversations.length),beforeDelete);await deletingRow.locator(".history-delete").click();await panel.locator("#confirmActionButton").click();await panel.waitForFunction(id=>!state.conversations.some(c=>c.id===id),deletingId);await waitIdle(panel);assert.equal(await panel.evaluate(()=>state.conversations.length),beforeDelete-1);log("single-conversation deletion requires confirmation and preserves other conversations");
  await panel.getByRole("button",{name:"设置",exact:true}).click();
  await panel.locator("#fontSizeSelect").selectOption("17");await screenshot(panel,"settings");
  log("history search/rename, full backup without Key, confirmed deletion, atomic restore, duplicate skipping, invalid/corrupt backup rejection and larger font");
  for(const width of [280,320,390,600]){await panel.setViewportSize({width,height:850});for(const view of ["chat","settings","history"]){await panel.evaluate(v=>showView(v),view);assert(!(await panel.evaluate(()=>document.documentElement.scrollWidth>innerWidth)),"overflow "+width+" "+view)}}await panel.setViewportSize({width:390,height:850});

  await question.goto(base+"/question");await question.bringToFront();
  const shortcutTarget=await panel.evaluate(async url=>{const [t]=await chrome.tabs.query({url});return{tabId:t.id,windowId:t.windowId}},question.url());
  await panel.close();
  await worker.evaluate(async t=>chrome.storage.session.set({["captureShortcut:"+t.windowId]:{id:"cold-regression",...t,createdAt:Date.now()}}),shortcutTarget);
  panel=await context.newPage();panel.on("pageerror",e=>errors.push(e.message));await question.bringToFront();await panel.goto("chrome-extension://"+id+"/sidepanel.html");
  await panel.waitForFunction(()=>state.ready&&state.selection);await question.locator("[data-question-selection]").waitFor();await question.keyboard.press("Escape");await panel.waitForFunction(()=>!state.selection);
  await worker.evaluate(async t=>chrome.storage.session.set({["captureShortcut:"+t.windowId]:{id:"warm-regression",...t,createdAt:Date.now()}}),shortcutTarget);
  await question.locator("[data-question-selection]").waitFor();await question.setViewportSize({width:420,height:850});await panel.waitForFunction(()=>!state.selection);assert.equal(await question.locator("[data-question-selection]").count(),0);
  await question.setViewportSize({width:390,height:850});log("cold/warm shortcut delivery and actual selection cleanup after page resize");

  const pdfUrl=base+"/question.pdf";await question.goto(pdfUrl);await question.bringToFront();await question.locator("embed").waitFor();await question.waitForTimeout(600);assert.equal(question.url(),pdfUrl);
  const pdfTarget=await panel.evaluate(async url=>{const [t]=await chrome.tabs.query({url});return{tabId:t.id,windowId:t.windowId,url:t.url}},question.url());
  await panel.evaluate(async()=>{state.pendingImages=[];renderAttachments();await persistDraft(true)});await panel.evaluate(t=>capture("screen",t),pdfTarget);await waitIdle(panel);assert.equal(await panel.evaluate(()=>state.pendingImages.length),1);
  const hasBlue=async()=>panel.evaluate(async()=>{const image=await loadImage(state.pendingImages.at(-1)),c=document.createElement("canvas");c.width=64;c.height=64;const x=c.getContext("2d");x.drawImage(image,0,0,64,64);const d=x.getImageData(0,0,64,64).data;return {w:image.width,h:image.height,blue:[...d].some((v,i)=>i%4===2&&v>d[i-2]+70&&v>d[i-1]+70)}});
  const onlinePixels=await hasBlue();assert(onlinePixels.w>200&&onlinePixels.h>200&&onlinePixels.blue);await question.screenshot({path:path.join(out,"pdf-viewer.png")});log("real built-in HTTPS PDF screenshot contains the distinct PDF graphic");
  await question.bringToFront();await panel.evaluate(t=>capture("region",t),pdfTarget);await panel.locator("#cropView.active").waitFor();await panel.evaluate(()=>{state.crop.rect={x1:0,y1:0,x2:250,y2:160};drawCrop()});await panel.locator("#useCropButton").click();await waitIdle(panel);assert.equal(await panel.evaluate(()=>state.pendingImages.length),2);log("PDF screenshot crop fallback completes and focuses composer");
  fs.writeFileSync(path.join(out,"fixture.pdf"),pdf());const localUrl=pathToFileURL(path.join(out,"fixture.pdf")).href;
  await question.goto(localUrl);await question.bringToFront();await question.locator("embed").waitFor();await question.waitForTimeout(600);
  assert(await worker.evaluate(()=>chrome.extension.isAllowedFileSchemeAccess()));
  const fileTarget=await panel.evaluate(async url=>{const [t]=await chrome.tabs.query({url});return{tabId:t.id,windowId:t.windowId,url:t.url}},localUrl);
  await panel.evaluate(t=>capture("screen",t),fileTarget);await waitIdle(panel);assert((await hasBlue()).blue);log("real local PDF capture with file access enabled");
  await question.goto("data:text/html,<h1>Restricted page question</h1>");await question.bringToFront();
  const restrictedTarget=await panel.evaluate(async url=>{const [t]=await chrome.tabs.query({url});return{tabId:t.id,windowId:t.windowId,url:t.url}},question.url());
  await panel.evaluate(t=>run(()=>selectOnPage(t)),restrictedTarget);await waitIdle(panel);assert((await panel.locator("#status").textContent()).includes("授权"));assert.equal(await panel.evaluate(()=>state.pendingImages.length),3);log("unauthorized restricted-page capture gives recovery guidance without changing attachments");
  await question.goto(base+"/black");await question.bringToFront();const blackTarget=await panel.evaluate(async url=>{const [t]=await chrome.tabs.query({url});return{tabId:t.id,windowId:t.windowId,url:t.url}},question.url());await panel.evaluate(async()=>{state.pendingImages=[];renderAttachments();await persistDraft(true)});await panel.evaluate(t=>capture("screen",t),blackTarget);await waitIdle(panel);assert((await panel.locator("#status").textContent()).includes("全黑"));log("real all-black capture displays quality warning before sending");
  await panel.bringToFront();
  await panel.evaluate(async image=>{
    const legacy={id:"legacy",title:"旧版题目",createdAt:1,updatedAt:2,mode:"concise",draftText:"旧版草稿",draftImages:[image],messages:[{id:"legacy-u",role:"user",content:"旧题",image,createdAt:1},{id:"legacy-a",role:"assistant",content:"保留的半段回答",streaming:true,createdAt:2}]};
    await Store.put(legacy);await chrome.storage.session.set({["activeConversation:"+state.windowId]:"legacy"});await chrome.storage.local.remove(recoveryKey());
  },sources[0]);await panel.reload();await waitIdle(panel);assert.equal(await panel.locator("#promptInput").inputValue(),"旧版草稿");assert.equal(await panel.evaluate(()=>state.current.messages[1].status),"interrupted");assert.equal(await panel.locator(".message-image").count(),1);assert.equal(await panel.locator(".attachment-card").count(),1);log("legacy database compatibility and interrupted-answer recovery");
  await panel.getByRole("button",{name:"设置",exact:true}).click();await panel.locator("#clearKeyButton").click();await panel.waitForFunction(()=>state.key==="");assert.equal(await panel.evaluate(async()=> (await chrome.storage.local.get("deepseekApiKey")).deepseekApiKey),undefined);
  const shortcutPagePromise=context.waitForEvent("page");await panel.locator("#changeShortcutButton").click();const shortcutPage=await shortcutPagePromise;await shortcutPage.waitForURL("edge://extensions/shortcuts");await shortcutPage.close();
  const detailsPromise=context.waitForEvent("page");await panel.locator("#openExtensionDetailsButton").click();const details=await detailsPromise;await details.waitForURL("edge://extensions/?id="+id);await details.close();log("Key removal and real Edge shortcut/extension settings links");
  assert.deepEqual(errors,[]);console.log("ALL BROWSER CHECKS PASSED");fs.writeFileSync(path.join(out,"browser-result.json"),JSON.stringify({passed:true,edge:context.browser().version(),profile,requests:requests.length},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{if(context)await context.close();server.close()});
