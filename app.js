"use strict";

const $ = (id) => document.getElementById(id);
const DB_NAME = "question-sidebar-v1";
const SYSTEM_PROMPT = "你是严谨的中文解题助手。先准确辨认用户截图中的题目，再给出答案和必要的推导步骤。遇到多小题，优先按用户指定的题号回答。若题干、数字、选项或图形看不清，明确指出看不清的部分并请用户重新截取；不要猜测或编造。对不确定的结论标明不确定。连续追问时结合先前对话和截图。数学公式请用 $...$ 或 $$...$$ 包住，不要输出没有定界符的 LaTeX 命令。";
const state = { db: null, conversations: [], current: null, key: "", pendingImage: null, cropImage: null, cropData: null, cropRect: null, dragging: false, selection: null, streamController: null, streamFinished: null, finishStream: null, saveTimer: null, statusTimer: null };

function showStatus(message, kind = "", persist = false) {
  const el = $("status");
  clearTimeout(state.statusTimer);
  el.textContent = message;
  el.className = `status ${kind}`;
  if (message && !persist) state.statusTimer = setTimeout(() => { el.textContent = ""; el.className = "status"; }, 6500);
}

function showView(name) {
  for (const el of document.querySelectorAll(".view")) el.classList.toggle("active", el.id === `${name}View`);
  if (name === "history") renderHistory();
  if (name === "settings") $("apiKeyInput").value = state.key;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("conversations", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(method, value) {
  return new Promise((resolve, reject) => {
    const transaction = state.db.transaction("conversations", method === "getAll" ? "readonly" : "readwrite");
    const request = transaction.objectStore("conversations")[method](...(value === undefined ? [] : [value]));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function newConversation() {
  return { id: crypto.randomUUID(), title: "新对话", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

async function persistCurrent() {
  if (!state.current) return;
  state.current.updatedAt = Date.now();
  await dbRequest("put", state.current);
  const index = state.conversations.findIndex((x) => x.id === state.current.id);
  if (index < 0) state.conversations.push(state.current);
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => persistCurrent().catch((error) => showStatus(`保存记录失败：${error.message}`, "error", true)), 500);
}

function stopStream() {
  if (state.streamController) state.streamController.abort();
}

async function switchConversation(conversation) {
  if (state.streamController) {
    stopStream();
    await state.streamFinished;
  }
  clearTimeout(state.saveTimer);
  await persistCurrent();
  state.current = conversation;
  await dbRequest("put", conversation);
  if (!state.conversations.some((item) => item.id === conversation.id)) state.conversations.push(conversation);
  state.pendingImage = null;
  updateAttachment();
  await chrome.storage.local.set({ activeConversationId: conversation.id });
  renderMessages();
  showView("chat");
  showStatus("");
}

function renderMessages() {
  const root = $("messages");
  root.replaceChildren();
  if (!state.current?.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = '<div class="empty-icon">∑</div><h1>从一道题开始</h1><p>点“框选题目”截取当前页面，写一句要求后直接发送。解题过程中可以继续追问。</p>';
    root.append(empty);
    return;
  }
  for (const message of state.current.messages) root.append(makeMessageNode(message));
  root.scrollTop = root.scrollHeight;
}

function renderMessageBody(element, message) {
  const content = message.content || (message.streaming ? "正在思考…" : "");
  const formatted = message.role === "assistant" && !message.streaming && !!globalThis.answerRenderer;
  element.classList.toggle("rendered", formatted);
  if (formatted) {
    try { element.innerHTML = globalThis.answerRenderer.render(content); }
    catch { element.classList.remove("rendered"); element.textContent = content; }
  } else element.textContent = content;
}

function makeMessageNode(message) {
  const item = document.createElement("article");
  item.className = `message ${message.role}${message.failed ? " failed" : ""}`;
  item.dataset.messageId = message.id;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = message.role === "user" ? "你" : "DeepSeek";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (message.image) {
    const img = document.createElement("img");
    img.className = "message-image";
    img.src = message.image;
    img.alt = "题目截图";
    bubble.append(img);
  }
  const body = document.createElement("div");
  body.className = "message-body";
  renderMessageBody(body, message);
  bubble.append(body);
  if (message.streaming) {
    const cursor = document.createElement("span");
    cursor.className = "typing";
    cursor.setAttribute("aria-hidden", "true");
    bubble.append(cursor);
  }
  item.append(meta, bubble);
  return item;
}

function updateMessageNode(message) {
  const item = $("messages").querySelector(`[data-message-id="${message.id}"]`);
  if (!item) return;
  item.classList.toggle("failed", !!message.failed);
  renderMessageBody(item.querySelector(".message-body"), message);
  const cursor = item.querySelector(".typing");
  if (!message.streaming && cursor) cursor.remove();
  $("messages").scrollTop = $("messages").scrollHeight;
}

function updateAttachment() {
  const has = !!state.pendingImage;
  $("attachment").classList.toggle("hidden", !has);
  if (has) {
    $("attachmentImage").src = state.pendingImage;
    $("attachmentSize").textContent = `${Math.round(state.pendingImage.length * 0.75 / 1024)} KB · 可继续输入要求`;
  } else $("attachmentImage").removeAttribute("src");
}

function renderHistory() {
  const list = $("historyList");
  list.replaceChildren();
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!sorted.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "还没有历史对话";
    list.append(empty);
  }
  for (const conversation of sorted) {
    const row = document.createElement("div");
    row.className = `history-item${conversation.id === state.current?.id ? " current" : ""}`;
    const open = document.createElement("button");
    open.className = "history-open";
    open.type = "button";
    const title = document.createElement("strong");
    title.textContent = conversation.title;
    const date = document.createElement("small");
    date.textContent = `${new Date(conversation.updatedAt).toLocaleString("zh-CN")} · ${conversation.messages.length} 条消息`;
    open.append(title, date);
    open.addEventListener("click", () => switchConversation(conversation).catch(reportError));
    const remove = document.createElement("button");
    remove.className = "history-delete";
    remove.type = "button";
    remove.title = "删除此对话";
    remove.setAttribute("aria-label", `删除${conversation.title}`);
    remove.textContent = "×";
    let armed = false;
    remove.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        remove.textContent = "删除?";
        remove.title = "再次点击确认删除";
        setTimeout(() => { armed = false; remove.textContent = "×"; remove.title = "删除此对话"; }, 4000);
      } else deleteConversation(conversation).catch(reportError);
    });
    row.append(open, remove);
    list.append(row);
  }
}

async function deleteConversation(conversation) {
  if (conversation.id === state.current?.id) {
    if (state.streamController) {
      stopStream();
      await state.streamFinished;
    }
    clearTimeout(state.saveTimer);
  }
  await dbRequest("delete", conversation.id);
  state.conversations = state.conversations.filter((x) => x.id !== conversation.id);
  if (conversation.id === state.current?.id) {
    state.current = state.conversations.sort((a, b) => b.updatedAt - a.updatedAt)[0] || newConversation();
    if (!state.conversations.includes(state.current)) {
      state.conversations.push(state.current);
      await dbRequest("put", state.current);
    }
    await chrome.storage.local.set({ activeConversationId: state.current.id });
    renderMessages();
  }
  renderHistory();
}

function reportError(error) { showStatus(error?.message || String(error), "error", true); }

// Runs inside the current webpage. It only records drag coordinates; the screenshot
// is captured by the extension after this temporary overlay has been removed.
function pageSelectionOverlay(sessionId) {
  const old = document.querySelector("[data-question-selection]");
  if (old) old.remove();
  const host = document.createElement("div");
  host.setAttribute("data-question-selection", sessionId);
  host.style.cssText = "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;margin:0!important;padding:0!important;cursor:crosshair!important;touch-action:none!important;user-select:none!important;";
  const root = host.attachShadow({ mode: "closed" });
  const surface = document.createElement("div");
  surface.style.cssText = "position:absolute;inset:0;background:rgba(7,31,37,.16);cursor:crosshair;touch-action:none;overflow:hidden;";
  const box = document.createElement("div");
  box.style.cssText = "display:none;position:absolute;border:2px solid #39d1bd;background:rgba(255,255,255,.06);box-shadow:0 0 0 10000px rgba(7,31,37,.28);pointer-events:none;box-sizing:border-box;";
  const hint = document.createElement("div");
  hint.textContent = "拖动框选题目 · Esc 取消";
  hint.style.cssText = "position:absolute;top:18px;left:50%;transform:translateX(-50%);padding:9px 15px;border-radius:9px;background:#173c3b;color:#fff;font:600 13px sans-serif;white-space:nowrap;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.2);";
  surface.append(box, hint);
  root.append(surface);
  document.documentElement.append(host);

  let origin = null;
  let dragging = false;
  let done = false;
  let timeout;
  const clamp = (value, max) => Math.max(0, Math.min(max, value));
  const emit = (type, extra = {}) => {
    try { chrome.runtime.sendMessage({ type, sessionId, ...extra }).catch(() => {}); } catch { /* Panel may have closed. */ }
  };
  const cleanup = () => {
    if (done) return false;
    done = true;
    clearTimeout(timeout);
    window.removeEventListener("keydown", onKey, true);
    host.remove();
    return true;
  };
  const cancel = () => { if (cleanup()) emit("question-selection-cancel"); };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  };
  window.addEventListener("keydown", onKey, true);
  timeout = setTimeout(cancel, 90000);

  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragging) return;
    event.preventDefault();
    event.stopPropagation();
    origin = { x: clamp(event.clientX, window.innerWidth), y: clamp(event.clientY, window.innerHeight) };
    dragging = true;
    surface.setPointerCapture(event.pointerId);
    surface.style.background = "transparent";
    box.style.display = "block";
  });
  surface.addEventListener("pointermove", (event) => {
    if (!dragging || !origin) return;
    event.preventDefault();
    event.stopPropagation();
    const x = clamp(event.clientX, window.innerWidth);
    const y = clamp(event.clientY, window.innerHeight);
    box.style.left = `${Math.min(origin.x, x)}px`;
    box.style.top = `${Math.min(origin.y, y)}px`;
    box.style.width = `${Math.abs(x - origin.x)}px`;
    box.style.height = `${Math.abs(y - origin.y)}px`;
  });
  surface.addEventListener("pointerup", (event) => {
    if (!dragging || !origin) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = false;
    const x = clamp(event.clientX, window.innerWidth);
    const y = clamp(event.clientY, window.innerHeight);
    const rect = { x: Math.min(origin.x, x), y: Math.min(origin.y, y), w: Math.abs(x - origin.x), h: Math.abs(y - origin.y) };
    origin = null;
    if (rect.w < 8 || rect.h < 8) {
      box.style.display = "none";
      surface.style.background = "rgba(7,31,37,.16)";
      hint.textContent = "选区太小，请重新拖动 · Esc 取消";
      return;
    }
    if (!cleanup()) return;
    // Two paint frames ensure the overlay is gone before captureVisibleTab runs.
    requestAnimationFrame(() => requestAnimationFrame(() => emit("question-selection-done", {
      rect,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    })));
  });
  surface.addEventListener("pointercancel", cancel);
}

function clearSelection() {
  if (state.selection?.timer) clearTimeout(state.selection.timer);
  state.selection = null;
}

async function selectOnPage() {
  if (state.streamController) { showStatus("请先等待回答结束或点击停止。", "error"); return; }
  if (state.selection) { showStatus("请在题目页面拖动框选，按 Esc 可取消。", ""); return; }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab?.windowId) throw new Error("找不到当前题目标签页。");
  const sessionId = crypto.randomUUID();
  state.selection = { sessionId, tabId: tab.id, windowId: tab.windowId, timer: null };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageSelectionOverlay, args: [sessionId] });
    if (state.selection?.sessionId !== sessionId) return;
    state.selection.timer = setTimeout(() => {
      if (state.selection?.sessionId !== sessionId) return;
      clearSelection();
      showStatus("框选已超时，请重新点击“框选题目”。", "error");
    }, 95000);
    showStatus("请直接在题目页面拖动框选；按 Esc 取消。", "", true);
  } catch {
    clearSelection();
    $("cropHint").textContent = "当前页面不允许直接画选框。请在这张可见区域截图上拖动选区。";
    await capture("region");
  }
}

async function completePageSelection(selection, payload) {
  const [active] = await chrome.tabs.query({ active: true, windowId: selection.windowId });
  if (active?.id !== selection.tabId) throw new Error("选区完成前切换了标签页，请回到题目页面重新框选。");
  const { rect, viewport } = payload;
  if (!viewport?.width || !viewport?.height || !rect || rect.w < 8 || rect.h < 8) throw new Error("选区无效，请重新框选。");
  showStatus("正在截取选区…", "", true);
  const dataUrl = await chrome.tabs.captureVisibleTab(selection.windowId, { format: "png" });
  const image = await loadImage(dataUrl);
  const scaleX = image.width / viewport.width;
  const scaleY = image.height / viewport.height;
  const x = Math.max(0, Math.min(image.width - 1, Math.round(rect.x * scaleX)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(rect.y * scaleY)));
  const w = Math.max(1, Math.min(image.width - x, Math.round(rect.w * scaleX)));
  const h = Math.max(1, Math.min(image.height - y, Math.round(rect.h * scaleY)));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, x, y, w, h, 0, 0, w, h);
  const black = looksBlack(context, w, h);
  state.pendingImage = normalizeCanvas(canvas);
  updateAttachment();
  showStatus(black ? "选区截图几乎全黑，可能是受保护画面；请检查缩略图。" : "题目已框选并加入聊天。", black ? "error" : "success");
}

chrome.runtime.onMessage.addListener((message, sender) => {
  const selection = state.selection;
  if (!selection || message?.sessionId !== selection.sessionId || sender.tab?.id !== selection.tabId) return;
  if (message.type === "question-selection-cancel") {
    clearSelection();
    showStatus("已取消框选。", "");
  } else if (message.type === "question-selection-done") {
    clearSelection();
    completePageSelection(selection, message).catch(reportError);
  }
});

async function capture(mode) {
  if (state.streamController) { showStatus("请先等待回答结束或点击停止。", "error"); return; }
  showStatus("正在截取当前标签页…", "", true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.windowId) throw new Error("找不到当前标签页。请切回题目页面后重试。");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (!dataUrl) throw new Error("截图未返回图像，请重试。");
    const image = await loadImage(dataUrl);
    if (image.width < 10 || image.height < 10) throw new Error("截图尺寸异常，请重试。");
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const black = looksBlack(ctx, canvas.width, canvas.height);
    if (mode === "region") {
      state.cropImage = image;
      state.cropData = dataUrl;
      state.cropRect = null;
      $("zoomInput").value = "1";
      drawCrop();
      showView("crop");
      showStatus("");
    } else {
      state.pendingImage = normalizeCanvas(canvas);
      updateAttachment();
      showView("chat");
      showStatus(black ? "截图内容几乎全黑，可能是受保护画面；发送前请检查缩略图。" : "整屏截图已加入，可直接发送。", black ? "error" : "success");
    }
    if (black && mode === "region") showStatus("截图内容几乎全黑，可能是受保护画面。", "error", true);
  } catch (error) {
    const details = error?.message || String(error);
    showStatus(`截图失败：${details} 若是本地 PDF，请在扩展详情里开启“允许访问文件 URL”。`, "error", true);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法解码截图。"));
    image.src = src;
  });
}

function looksBlack(ctx, width, height) {
  let dark = 0;
  let checked = 0;
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
    const pixel = ctx.getImageData(Math.floor((x + 0.5) * width / 10), Math.floor((y + 0.5) * height / 10), 1, 1).data;
    if (pixel[0] < 15 && pixel[1] < 15 && pixel[2] < 15) dark++;
    checked++;
  }
  return dark / checked > 0.96;
}

function normalizeCanvas(canvas) {
  const png = canvas.toDataURL("image/png");
  return png.length < 4 * 1024 * 1024 ? png : canvas.toDataURL("image/jpeg", 0.92);
}

function drawCrop() {
  if (!state.cropImage) return;
  const canvas = $("cropCanvas");
  canvas.width = state.cropImage.width;
  canvas.height = state.cropImage.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(state.cropImage, 0, 0);
  if (state.cropRect) {
    const { x, y, w, h } = normalizedRect(state.cropRect);
    ctx.fillStyle = "rgba(22,126,119,.13)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#087b71";
    ctx.lineWidth = Math.max(3, canvas.width / 550);
    ctx.setLineDash([ctx.lineWidth * 2, ctx.lineWidth]);
    ctx.strokeRect(x, y, w, h);
  }
  canvas.style.width = `${Number($("zoomInput").value) * 100}%`;
  $("zoomLabel").textContent = `${Math.round(Number($("zoomInput").value) * 100)}%`;
  $("useCropButton").disabled = !state.cropRect || normalizedRect(state.cropRect).w < 8 || normalizedRect(state.cropRect).h < 8;
}

function pointOnCrop(event) {
  const canvas = $("cropCanvas");
  const box = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - box.left) * canvas.width / box.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - box.top) * canvas.height / box.height))
  };
}

function normalizedRect(rect) {
  return { x: Math.min(rect.x1, rect.x2), y: Math.min(rect.y1, rect.y2), w: Math.abs(rect.x2 - rect.x1), h: Math.abs(rect.y2 - rect.y1) };
}

function useCrop() {
  if (!state.cropImage || !state.cropRect) return;
  const rect = normalizedRect(state.cropRect);
  if (rect.w < 8 || rect.h < 8) return;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(rect.w);
  canvas.height = Math.ceil(rect.h);
  canvas.getContext("2d").drawImage(state.cropImage, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
  state.pendingImage = normalizeCanvas(canvas);
  state.cropImage = null;
  state.cropData = null;
  updateAttachment();
  showView("chat");
  showStatus("选区截图已加入，可补充要求后发送。", "success");
}

function buildApiMessages(messages) {
  const recent = messages.filter((m) => !m.failed && !m.streaming).slice(-30);
  let imageCount = 0;
  let imageBytes = 0;
  const includeImage = new Set();
  for (let i = recent.length - 1; i >= 0; i--) {
    const image = recent[i].image;
    if (image && imageCount < 4 && imageBytes + image.length < 25 * 1024 * 1024) {
      includeImage.add(recent[i].id);
      imageCount++;
      imageBytes += image.length;
    }
  }
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...recent.map((message) => {
      if (message.role === "assistant") return { role: "assistant", content: message.content };
      const content = [{ type: "text", text: message.content + (message.image && !includeImage.has(message.id) ? "\n[较早的截图未随本轮请求附上；若需查看，请让用户重新截图。]" : "") }];
      if (message.image && includeImage.has(message.id)) content.push({ type: "image_url", image_url: { url: message.image, detail: "original" } });
      return { role: "user", content };
    })
  ];
}

async function streamAnswer(messages, onDelta, signal) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${state.key}` },
    body: JSON.stringify({ model: "deepseek-flash", messages: buildApiMessages(messages), stream: true }),
    signal
  });
  if (!response.ok) {
    let detail = "";
    try { const body = await response.json(); detail = body.error?.message || ""; } catch { /* The status is still useful. */ }
    throw new Error(`DeepSeek 返回 ${response.status}${detail ? `：${detail}` : ""}`);
  }
  if (!response.body) throw new Error("接口未返回可读取的数据流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { completed = true; break; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new Error(chunk.error.message || "接口返回错误。");
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) onDelta(delta);
    }
    if (completed) break;
  }
  if (!completed) throw new Error("回答数据流提前结束。请重试。");
}

async function sendMessage() {
  if (state.streamController) return;
  if (!state.key) { showView("settings"); showStatus("先填写 DeepSeek API Key。", "error", true); return; }
  const typed = $("promptInput").value.trim();
  if (!typed && !state.pendingImage) { showStatus("先输入问题或截取题目。", "error"); return; }
  const user = { id: crypto.randomUUID(), role: "user", content: typed || "请解答截图中的题目，给出答案和必要步骤。", image: state.pendingImage || null, createdAt: Date.now() };
  const assistant = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: Date.now(), streaming: true };
  state.current.messages.push(user, assistant);
  if (state.current.title === "新对话") state.current.title = typed ? typed.slice(0, 25) : "截图题目";
  state.pendingImage = null;
  $("promptInput").value = "";
  updateAttachment();
  renderMessages();
  await persistCurrent();
  const context = state.current.messages.slice(0, -1);
  const controller = new AbortController();
  state.streamController = controller;
  state.streamFinished = new Promise((resolve) => { state.finishStream = resolve; });
  $("sendButton").classList.add("hidden");
  $("stopButton").classList.remove("hidden");
  showStatus("");
  try {
    await streamAnswer(context, (delta) => {
      assistant.content += delta;
      updateMessageNode(assistant);
      scheduleSave();
    }, controller.signal);
    if (!assistant.content.trim()) throw new Error("接口没有返回文字，请重试。");
  } catch (error) {
    if (error.name === "AbortError") {
      assistant.failed = true;
      assistant.content = assistant.content ? `${assistant.content}\n\n[已停止生成]` : "已停止生成。";
    } else {
      assistant.failed = true;
      assistant.content = assistant.content ? `${assistant.content}\n\n[回答中断：${error.message}]` : `请求失败：${error.message}`;
      showStatus(error.message, "error", true);
    }
  } finally {
    assistant.streaming = false;
    $("sendButton").classList.remove("hidden");
    $("stopButton").classList.add("hidden");
    updateMessageNode(assistant);
    clearTimeout(state.saveTimer);
    try { await persistCurrent(); }
    finally {
      state.streamController = null;
      state.finishStream();
      state.streamFinished = null;
      state.finishStream = null;
    }
  }
}

async function init() {
  state.db = await openDb();
  const stored = await chrome.storage.local.get(["deepseekApiKey", "activeConversationId"]);
  state.key = stored.deepseekApiKey || "";
  state.conversations = await dbRequest("getAll");
  for (const conversation of state.conversations) {
    let repaired = false;
    for (const message of conversation.messages) {
      if (!message.streaming) continue;
      message.streaming = false;
      message.failed = true;
      message.content = message.content ? `${message.content}\n\n[上次回答中断]` : "上次回答中断，请重新提问。";
      repaired = true;
    }
    if (repaired) await dbRequest("put", conversation);
  }
  state.current = state.conversations.find((x) => x.id === stored.activeConversationId) || [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0] || newConversation();
  if (!state.conversations.some((x) => x.id === state.current.id)) { state.conversations.push(state.current); await dbRequest("put", state.current); }
  await chrome.storage.local.set({ activeConversationId: state.current.id });
  renderMessages();
  if (!state.key) showStatus("在设置中填入 DeepSeek API Key 后即可开始。", "", true);
}

$("historyButton").addEventListener("click", () => showView("history"));
$("newButton").addEventListener("click", () => switchConversation(newConversation()).catch(reportError));
$("settingsButton").addEventListener("click", () => showView("settings"));
for (const button of document.querySelectorAll("[data-back]")) button.addEventListener("click", () => showView(button.dataset.back));
$("regionButton").addEventListener("click", () => selectOnPage().catch(reportError));
$("screenButton").addEventListener("click", () => capture("screen"));
$("removeImageButton").addEventListener("click", () => { state.pendingImage = null; updateAttachment(); });
$("useScreenButton").addEventListener("click", async () => {
  const image = await loadImage(state.cropData);
  const canvas = document.createElement("canvas");
  canvas.width = image.width; canvas.height = image.height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  state.pendingImage = normalizeCanvas(canvas);
  state.cropImage = null; state.cropData = null;
  updateAttachment(); showView("chat"); showStatus("整屏截图已加入。", "success");
});
$("useCropButton").addEventListener("click", useCrop);
$("zoomInput").addEventListener("input", drawCrop);
$("cropCanvas").addEventListener("pointerdown", (event) => {
  const point = pointOnCrop(event);
  state.cropRect = { x1: point.x, y1: point.y, x2: point.x, y2: point.y };
  state.dragging = true;
  $("cropCanvas").setPointerCapture(event.pointerId);
  drawCrop();
});
$("cropCanvas").addEventListener("pointermove", (event) => {
  if (!state.dragging || !state.cropRect) return;
  const point = pointOnCrop(event);
  state.cropRect.x2 = point.x; state.cropRect.y2 = point.y;
  drawCrop();
});
for (const type of ["pointerup", "pointercancel"]) $("cropCanvas").addEventListener(type, () => { state.dragging = false; drawCrop(); });
$("composeForm").addEventListener("submit", (event) => { event.preventDefault(); sendMessage().catch(reportError); });
$("promptInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage().catch(reportError); }
});
$("stopButton").addEventListener("click", stopStream);
$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = $("apiKeyInput").value.trim();
  if (!key) { showStatus("API Key 不能为空。", "error", true); return; }
  state.key = key;
  await chrome.storage.local.set({ deepseekApiKey: key });
  $("apiKeyInput").value = "";
  showView("chat");
  showStatus("API Key 已保存。", "success");
});
$("toggleKeyButton").addEventListener("click", () => {
  const input = $("apiKeyInput");
  input.type = input.type === "password" ? "text" : "password";
  $("toggleKeyButton").textContent = input.type === "password" ? "显示" : "隐藏";
});
$("clearKeyButton").addEventListener("click", async () => {
  state.key = "";
  $("apiKeyInput").value = "";
  await chrome.storage.local.remove("deepseekApiKey");
  showStatus("已删除保存的 API Key。", "success");
});

init().catch(reportError);
