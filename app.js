"use strict";

const $ = (id) => document.getElementById(id);
const DB_NAME = "question-sidebar-v1";
const SYSTEM_PROMPT = "你是严谨的中文解题助手。先判断题型和用户指定的小题，再严格按当前回答模式作答。题干、数字、选项或图形看不清时，明确指出看不清的部分并请用户重新截取；不要猜测或编造。连续追问时结合先前对话和截图。数学公式请用 $...$ 或 $$...$$ 包住，不要输出没有定界符的 LaTeX 命令。";
const MODE_PROMPTS = {
  steps: "按分步讲解模式回答：展示解题过程，每一步说明理由，最后清楚给出答案。选择题也说明关键判断依据。",
  concise: "按题型控制输出长度，严格遵守：选择题只给正确选项的字母或编号，不解释；填空题只给应填内容，多空按顺序列出，不推导；判断题只给判断结果。证明题、解答题和计算题给出完成题目必需的最少推导步骤，并明确结论。不要添加寒暄、题意复述或额外讲解。题目有多小题时，按题号对应给出结果。",
  check: "按检查作答模式回答：核对用户给出的解答，指出第一处错误或确认正确，并说明原因和修正方法。若用户尚未提供自己的作答，请先请用户贴出作答，不要直接替他完整重做。"
};
const state = { db: null, conversations: [], current: null, key: "", pendingImages: [], imageLoading: false, sending: false, cropImage: null, cropData: null, cropRect: null, dragging: false, selection: null, streamController: null, streamFinished: null, finishStream: null, saveTimer: null, statusTimer: null };

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
  $("apiKeyInput").type = "password"; $("toggleKeyButton").textContent = "显示";
  $("apiKeyInput").value = name === "settings" ? state.key : "";
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
    let result;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error("本地记录写入失败"));
    transaction.onerror = () => reject(transaction.error);
  });
}

function newConversation() {
  return { id: crypto.randomUUID(), title: "新对话", mode: "steps", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

async function persistCurrent() {
  if (!state.current) return;
  state.current.updatedAt = Date.now();
  await dbRequest("put", state.current);
  const index = state.conversations.findIndex((x) => x.id === state.current.id);
  if (index < 0) state.conversations.push(state.current);
}

function scheduleSave() {
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    persistCurrent().catch(reportError);
  }, 500);
}

function stashDraft() {
  if (!state.current) return;
  state.current.draftText = $("promptInput").value;
  state.current.draftImages = [...state.pendingImages];
  scheduleSave();
}

function updateComposer() {
  $("sendButton").disabled = !state.current || state.sending || state.imageLoading || (!$("promptInput").value.trim() && !state.pendingImages.length);
  const mode = state.current?.mode || "steps";
  $("modeSelect").value = MODE_PROMPTS[mode] ? mode : "steps";
  $("promptInput").placeholder = mode === "check" ? "贴上你的作答，AI 会逐步帮你检查…" : "问一道题，或继续追问…";
  const input = $("promptInput");
  input.style.height = "auto";
  input.style.height = `${Math.min(160, Math.max(56, input.scrollHeight))}px`;
  $("conversationTitle").textContent = state.current?.title || "新对话";
}

function stopStream() {
  if (state.streamController) state.streamController.abort();
}

async function switchConversation(conversation) {
  if (state.streamController) {
    stopStream();
    await state.streamFinished;
  }
  stashDraft();
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  await persistCurrent();
  state.current = conversation;
  state.current.mode ||= "steps";
  await dbRequest("put", conversation);
  if (!state.conversations.some((item) => item.id === conversation.id)) state.conversations.push(conversation);
  state.pendingImages = [...(conversation.draftImages || [])];
  $("promptInput").value = conversation.draftText || "";
  updateAttachment();
  await chrome.storage.local.set({ activeConversationId: conversation.id });
  renderMessages();
  showView("chat");
  showStatus("");
}

function renderMessages() {
  updateComposer();
  const root = $("messages");
  root.replaceChildren();
  if (!state.current?.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = '<div class="empty-kicker">YOUR STUDY SPACE</div><h1>从一道题开始。</h1><p>框选网页上的题目，或粘贴一张图片。<br>解题、梳理思路，然后继续追问。</p><div class="empty-actions"><button type="button" data-empty="capture">框选一道题</button><button type="button" data-empty="upload">添加图片</button></div>';
    empty.querySelector('[data-empty="capture"]').onclick = () => selectOnPage().catch(reportError);
    empty.querySelector('[data-empty="upload"]').onclick = () => $("imageFileInput").click();
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
  const images = messageImages(message);
  if (images.length) {
    const gallery = document.createElement("div");
    gallery.className = "message-images";
    for (const src of images) {
      const img = document.createElement("img");
      img.className = "message-image"; img.src = src; img.alt = "题目截图";
      img.tabIndex = 0; img.setAttribute("role", "button");
      img.onclick = () => previewImage(src);
      img.onkeydown = (event) => { if (event.key === "Enter") previewImage(src); };
      gallery.append(img);
    }
    bubble.append(gallery);
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
  appendMessageActions(item, message);
  return item;
}

function updateMessageNode(message) {
  const item = $("messages").querySelector(`[data-message-id="${message.id}"]`);
  if (!item) return;
  const follow = $("messages").scrollHeight - $("messages").scrollTop - $("messages").clientHeight < 90;
  item.classList.toggle("failed", !!message.failed);
  renderMessageBody(item.querySelector(".message-body"), message);
  const cursor = item.querySelector(".typing");
  if (!message.streaming && cursor) cursor.remove();
  if (!message.streaming) appendMessageActions(item, message);
  if (follow) $("messages").scrollTop = $("messages").scrollHeight;
}

function messageImages(message) { return message.images || (message.image ? [message.image] : []); }

function previewImage(src) {
  $("fullPreviewImage").classList.remove("original-size");
  $("fullPreviewImage").src = src;
  showView("preview");
}

function updateAttachment() {
  const root = $("attachment");
  root.replaceChildren();
  root.classList.toggle("hidden", !state.pendingImages.length);
  state.pendingImages.forEach((src, index) => {
    const card = document.createElement("div"); card.className = "attachment-card";
    const preview = document.createElement("button"); preview.type = "button"; preview.className = "attachment-preview"; preview.title = `预览第 ${index + 1} 张图片`;
    const image = document.createElement("img"); image.src = src; image.alt = `题目图片 ${index + 1}`;
    preview.append(image); preview.onclick = () => previewImage(src);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "attachment-remove"; remove.textContent = "×";
    remove.setAttribute("aria-label", `移除第 ${index + 1} 张图片`);
    remove.onclick = () => { state.pendingImages.splice(index, 1); updateAttachment(); };
    card.append(preview, remove); root.append(card);
  });
  if (state.pendingImages.length) {
    const count = document.createElement("span"); count.className = "attachment-count"; count.textContent = `${state.pendingImages.length} / 4`; root.append(count);
  }
  stashDraft(); updateComposer();
}

function addAttachment(src) {
  if (state.pendingImages.length >= 4) throw new Error("每次最多添加 4 张图片，请先发送或移除一张。");
  state.pendingImages.push(src); updateAttachment();
}

async function importImages(files) {
  if (state.imageLoading) return;
  state.imageLoading = true; updateComposer();
  let added = 0;
  try {
    for (const file of files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("支持 PNG、JPEG、WebP 和 GIF 图片。");
      if (state.pendingImages.length >= 4) throw new Error("每次最多添加 4 张图片，已保留成功添加的图片。");
      if (file.size > 20 * 1024 * 1024) throw new Error("单张图片请小于 20 MB。");
      const url = URL.createObjectURL(file);
      try {
        const image = await loadImage(url);
        const ratio = Math.min(1, 4096 / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        addAttachment(normalizeCanvas(canvas)); added++;
      } finally { URL.revokeObjectURL(url); }
    }
    if (added) showStatus(`已添加 ${added} 张图片。`, "success");
  } catch (error) { reportError(error); }
  finally { state.imageLoading = false; updateComposer(); $("imageFileInput").value = ""; }
}

function appendMessageActions(item, message) {
  item.querySelector(".message-actions")?.remove();
  if (message.role !== "assistant" || message.streaming) return;
  const row = document.createElement("div"); row.className = "message-actions";
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "message-action"; copy.textContent = "复制回答";
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(message.content); copy.textContent = "已复制"; setTimeout(() => { copy.textContent = "复制回答"; }, 1600); }
    catch { showStatus("复制失败，请选中文字后复制。", "error"); }
  };
  row.append(copy);
  if (state.current?.messages.at(-1)?.id === message.id) {
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "message-action"; retry.textContent = message.failed ? "重试" : "重新回答";
    retry.onclick = () => retryMessage(message).catch(reportError); row.append(retry);
  }
  item.append(row);
}

function exportConversation() {
  if (!state.current?.messages.length) { showStatus("当前对话还没有内容。"); return; }
  const text = `# ${state.current.title}\n\n` + state.current.messages.map((m) => `## ${m.role === "user" ? "提问" : "回答"}\n\n${m.content}${messageImages(m).length ? `\n\n（附图 ${messageImages(m).length} 张）` : ""}`).join("\n\n---\n\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${state.current.title.replace(/[\\/:*?"<>|]/g, "_")}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderHistory() {
  const list = $("historyList");
  list.replaceChildren();
  const query = $("historySearch").value.trim().toLowerCase();
  const sorted = [...state.conversations].filter((c) => !query || c.title.toLowerCase().includes(query) || c.messages.some((m) => m.content.toLowerCase().includes(query))).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!sorted.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = query ? "没有找到匹配的对话" : "还没有历史对话";
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
    const rename = document.createElement("button"); rename.type = "button"; rename.className = "history-rename"; rename.textContent = "命名";
    rename.onclick = () => {
      const input = document.createElement("input"); input.className = "history-title-input"; input.value = conversation.title; input.maxLength = 60;
      open.replaceWith(input); input.focus(); input.select();
      let saved = false;
      const save = async () => { if (saved) return; saved = true; conversation.title = input.value.trim() || conversation.title; await dbRequest("put", conversation); renderHistory(); updateComposer(); };
      input.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); save().catch(reportError); } if (event.key === "Escape") { saved = true; renderHistory(); } };
      input.onblur = () => save().catch(reportError);
    };
    row.append(open, rename, remove);
    list.append(row);
  }
}

async function deleteConversation(conversation) {
  if (conversation.id === state.current?.id) {
    if (state.streamController) {
      stopStream();
      await state.streamFinished;
    }
    clearTimeout(state.saveTimer); state.saveTimer = null;
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
    state.pendingImages = [...(state.current.draftImages || [])];
    $("promptInput").value = state.current.draftText || "";
    updateAttachment();
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
  if (state.imageLoading) { showStatus("图片还在导入，请稍等。", "error"); return; }
  if (state.pendingImages.length >= 4) { showStatus("已添加 4 张图片，请先发送或移除一张。", "error"); return; }
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
  addAttachment(normalizeCanvas(canvas));
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
  if (state.imageLoading) { showStatus("图片还在导入，请稍等。", "error"); return; }
  if (state.pendingImages.length >= 4) { showStatus("已添加 4 张图片，请先发送或移除一张。", "error"); return; }
  if (state.selection) { showStatus("请先完成网页框选，或按 Esc 取消。"); return; }
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
      addAttachment(normalizeCanvas(canvas));
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
  if (png.length < 4 * 1024 * 1024) return png;
  const flattened = document.createElement("canvas");
  flattened.width = canvas.width; flattened.height = canvas.height;
  const context = flattened.getContext("2d");
  context.fillStyle = "#fff"; context.fillRect(0, 0, flattened.width, flattened.height);
  context.drawImage(canvas, 0, 0);
  return flattened.toDataURL("image/jpeg", 0.92);
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
  addAttachment(normalizeCanvas(canvas));
  state.cropImage = null;
  state.cropData = null;
  updateAttachment();
  showView("chat");
  showStatus("选区截图已加入，可补充要求后发送。", "success");
}

function buildApiMessages(messages) {
  const recent = messages.filter((m) => !m.failed && !m.streaming).slice(-30);
  let count = 0, bytes = 0;
  const selected = new Map();
  for (let i = recent.length - 1; i >= 0; i--) {
    const images = messageImages(recent[i]); const chosen = [];
    for (let j = images.length - 1; j >= 0; j--) {
      if (count < 4 && bytes + images[j].length < 25 * 1024 * 1024) { chosen.unshift(images[j]); count++; bytes += images[j].length; }
    }
    selected.set(recent[i].id, chosen);
  }
  return [{ role: "system", content: `${SYSTEM_PROMPT}\n\n${MODE_PROMPTS[state.current?.mode] || MODE_PROMPTS.steps}` }, ...recent.map((message) => {
    if (message.role === "assistant") return { role: "assistant", content: message.content };
    const images = selected.get(message.id) || [];
    const omitted = images.length < messageImages(message).length;
    const content = [{ type: "text", text: message.content + (omitted ? "\n[本轮未附上部分旧截图，需要时请用户重新添加。]" : "") }];
    for (const image of images) content.push({ type: "image_url", image_url: { url: image, detail: "original" } });
    return { role: "user", content };
  })];
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
  if (state.sending || state.imageLoading || !state.current) return;
  if (!state.key) { showView("settings"); showStatus("先填写 DeepSeek API Key。", "error", true); return; }
  const typed = $("promptInput").value.trim();
  if (!typed && !state.pendingImages.length) return;
  const user = { id: crypto.randomUUID(), role: "user", content: typed || "请解答图片中的题目，给出答案和必要步骤。", images: [...state.pendingImages], createdAt: Date.now() };
  state.current.messages.push(user);
  if (state.current.title === "新对话") state.current.title = typed ? typed.slice(0, 25) : "截图题目";
  state.pendingImages = []; $("promptInput").value = ""; updateAttachment();
  const assistant = { id: crypto.randomUUID(), role: "assistant", content: "", createdAt: Date.now(), streaming: true };
  const context = [...state.current.messages]; state.current.messages.push(assistant);
  await generateAnswer(context, assistant);
}

async function retryMessage(message) {
  if (state.sending || state.current?.messages.at(-1)?.id !== message.id) return;
  if (!state.key) { showView("settings"); showStatus("先填写 DeepSeek API Key。", "error", true); return; }
  const context = state.current.messages.slice(0, -1);
  message.content = ""; message.failed = false; message.streaming = true;
  await generateAnswer(context, message);
}

async function generateAnswer(context, assistant) {
  const controller = new AbortController();
  state.sending = true; state.streamController = controller;
  state.streamFinished = new Promise((resolve) => { state.finishStream = resolve; });
  $("sendButton").classList.add("hidden"); $("stopButton").classList.remove("hidden");
  renderMessages(); showStatus("");
  try {
    await persistCurrent();
    await streamAnswer(context, (delta) => { assistant.content += delta; updateMessageNode(assistant); scheduleSave(); }, controller.signal);
    if (!assistant.content.trim()) throw new Error("没有收到回答，请点击重试。");
  } catch (error) {
    assistant.failed = true;
    if (error.name === "AbortError") assistant.content = assistant.content ? `${assistant.content}\n\n[已停止生成]` : "已停止生成。";
    else { assistant.content = assistant.content ? `${assistant.content}\n\n[回答中断：${error.message}]` : `请求失败：${error.message}`; showStatus(error.message, "error", true); }
  } finally {
    assistant.streaming = false;
    $("sendButton").classList.remove("hidden"); $("stopButton").classList.add("hidden");
    updateMessageNode(assistant); clearTimeout(state.saveTimer); state.saveTimer = null;
    try { await persistCurrent(); }
    finally { state.streamController = null; state.sending = false; state.finishStream(); state.streamFinished = null; state.finishStream = null; updateComposer(); }
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
  state.current.mode ||= "steps";
  if (!state.conversations.some((x) => x.id === state.current.id)) { state.conversations.push(state.current); await dbRequest("put", state.current); }
  await chrome.storage.local.set({ activeConversationId: state.current.id });
  state.pendingImages = [...(state.current.draftImages || [])];
  $("promptInput").value = state.current.draftText || "";
  updateAttachment();
  renderMessages();
  if (!state.key) showStatus("在设置中填入 DeepSeek API Key 后即可开始。", "", true);
}

$("historyButton").addEventListener("click", () => showView("history"));
$("newButton").addEventListener("click", () => switchConversation(newConversation()).catch(reportError));
$("settingsButton").addEventListener("click", () => showView("settings"));
for (const button of document.querySelectorAll("[data-back]")) button.addEventListener("click", () => showView(button.dataset.back));
$("regionButton").addEventListener("click", () => selectOnPage().catch(reportError));
$("screenButton").addEventListener("click", () => capture("screen"));

$("useScreenButton").addEventListener("click", async () => {
  const image = await loadImage(state.cropData);
  const canvas = document.createElement("canvas");
  canvas.width = image.width; canvas.height = image.height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  addAttachment(normalizeCanvas(canvas));
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

$("promptInput").addEventListener("input", () => { stashDraft(); updateComposer(); });
$("modeSelect").addEventListener("change", () => {
  if (!state.current) return;
  state.current.mode = MODE_PROMPTS[$("modeSelect").value] ? $("modeSelect").value : "steps";
  stashDraft();
  dbRequest("put", state.current).catch(reportError);
  updateComposer();
});
$("fullPreviewImage").addEventListener("click", () => $("fullPreviewImage").classList.toggle("original-size"));
$("historySearch").addEventListener("input", renderHistory);
$("exportButton").addEventListener("click", exportConversation);
$("uploadButton").addEventListener("click", () => $("imageFileInput").click());
$("imageFileInput").addEventListener("change", (event) => importImages([...event.target.files]));
document.addEventListener("paste", (event) => {
  if (!$("chatView").classList.contains("active")) return;
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); importImages(files); }
});
const dropZone = $("composeForm");
for (const type of ["dragenter", "dragover"]) dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
dropZone.addEventListener("dragleave", (event) => { if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("dragging"); });
dropZone.addEventListener("drop", (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); importImages([...event.dataTransfer.files]); });
init().catch(reportError);
