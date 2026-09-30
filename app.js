"use strict";
const $ = (id) => document.getElementById(id);
const C = QuestionCore, Store = QuestionStore, Api = DeepSeekApi;
const state = {
  ready: false, submitting: false, conversations: [], current: null, key: "", mode: "steps", edit: null,
  pendingImages: [], assetBusy: "", selection: null, crop: null, preview: null,
  running: null, saveChain: Promise.resolve(), draftTimer: null, streamSaveTimer: null, renderTimer: null,
  windowId: null, lastShortcutId: null, lastCaptureAt: 0, noticeTimer: null, view: "chat",
  confirm: null, restoreData: null, checkAbort: null, recoveryStamp: 0, draggedImage: null
};

const run = (action) => Promise.resolve().then(action).catch(reportError);
function makeButton(label, className, action, ariaLabel) {
  const b = document.createElement("button");
  b.type = "button"; b.className = className; b.textContent = label;
  if (ariaLabel) b.setAttribute("aria-label", ariaLabel);
  b.onclick = () => run(action);
  return b;
}
function notice(message = "", kind = "", action = null) {
  clearTimeout(state.noticeTimer);
  const root = $("status"); root.replaceChildren(); root.className = "status " + kind;
  if (!message) return;
  const text = document.createElement("span"); text.textContent = message; root.append(text);
  if (action) root.append(makeButton(action.label, "notice-action", action.run));
  root.append(makeButton("×", "notice-close", () => notice(), "关闭提示"));
  if (kind !== "error" && !action) state.noticeTimer = setTimeout(() => notice(), 6500);
}
function reportError(error) {
  if (error?.name === "AbortError") return;
  let message = error?.message || "操作失败，请重试。";
  if (state.key) message = message.replaceAll(state.key, "[Key]");
  const action = error?.code === "key" ? { label: "打开设置", run: () => showView("settings") } : null;
  notice(message, "error", action);
}
function showView(name) {
  if (state.view === "settings" && name !== "settings") state.checkAbort?.abort();
  if (state.view === "preview" && name !== "preview") { state.preview = null; $("fullPreviewImage").removeAttribute("src"); }
  if (state.view === "crop" && name !== "crop") { state.crop = null; $("cropCanvas").width = 1; $("cropCanvas").height = 1; }
  if (state.view === "restore" && name !== "restore") state.restoreData = null;
  state.view = name;
  for (const el of document.querySelectorAll(".view")) el.classList.toggle("active", el.id === name + "View");
  if (name === "history") renderHistory();
  $("apiKeyInput").type = "password"; $("toggleKeyButton").textContent = "显示";
  $("apiKeyInput").value = name === "settings" ? state.key : "";
  if (name === "settings") refreshShortcutLabel().catch(reportError);
}
function focusComposer() {
  showView("chat");
  requestAnimationFrame(() => { window.focus(); $("promptInput").focus({ preventScroll: true }); });
}
function updateControls() {
  const busy = !!state.assetBusy || !!state.selection || state.submitting;
  $("promptInput").disabled = !state.ready;
  $("sendButton").disabled = !state.ready || busy || !!state.running || (!$("promptInput").value.trim() && !state.pendingImages.length);
  $("sendButton").classList.toggle("hidden", !!state.running);
  $("stopButton").classList.toggle("hidden", !state.running);
  for (const name of ["regionButton", "screenButton", "uploadButton", "newButton"]) $(name).disabled = !state.ready || busy;
  $("modeSelect").disabled = !state.ready;
  $("modeSelect").value = state.mode;
  $("promptInput").placeholder = state.mode === "check" ? "贴上你的作答，AI 会逐步帮你检查…" : "问一道题，或继续追问…";
  $("busyLabel").textContent = state.running ? "正在回答" : state.submitting ? "正在发送" : state.assetBusy ? "正在处理" : "DeepSeek";
  document.querySelectorAll("[data-requires-idle]").forEach((b) => { b.disabled = !!state.running || !!state.assetBusy || state.submitting; });
  document.querySelectorAll("[data-move-to]").forEach((b) => { const to = Number(b.dataset.moveTo); b.disabled = busy || to < 0 || to >= state.pendingImages.length; });
  document.querySelectorAll(".attachment-remove,.attachment-footer button").forEach((b) => { b.disabled = busy; });
  $("editBanner").classList.toggle("hidden", !state.edit);
  $("sendButton").title = state.edit ? "修改并重新作答" : "发送";
  $("conversationTitle").textContent = state.current?.title || "新对话";
  const source = state.current?.branchSource?.conversationId;
  $("sourceConversationButton").classList.toggle("hidden", !source || !state.conversations.some((c) => c.id === source));
  const input = $("promptInput");
  input.style.height = "auto"; input.style.height = Math.min(160, Math.max(56, input.scrollHeight)) + "px";
}
function save(conversation, touch = true) {
  if (!conversation) return Promise.resolve();
  if (touch) conversation.updatedAt = Date.now();
  const snapshot = C.copy(conversation);
  state.saveChain = state.saveChain.catch(() => {}).then(() => Store.put(snapshot));
  return state.saveChain;
}
function recoveryKey() { return "draftRecovery:" + state.windowId; }
function persistDraft(immediate = false) {
  if (!state.current || !state.ready) return Promise.resolve();
  const c = state.current;
  if (state.edit) c.editDraft = { messageId: state.edit.messageId, text: $("promptInput").value, images: [...state.pendingImages], mode: state.mode };
  else { c.draftText = $("promptInput").value; c.draftImages = [...state.pendingImages]; c.mode = state.mode; }
  const recovery = { conversationId: c.id, messageId: state.edit?.messageId || null, text: $("promptInput").value, mode: state.mode, updatedAt: Date.now() };
  chrome.storage.local.set({ [recoveryKey()]: recovery }).catch(reportError);
  clearTimeout(state.draftTimer);
  if (immediate) { state.draftTimer = null; return save(c); }
  state.draftTimer = setTimeout(() => { state.draftTimer = null; save(c).catch(reportError); }, 200);
  return Promise.resolve();
}
async function flushDraft() { await persistDraft(true); await state.saveChain; }
function restoreComposer(c) {
  const edit = c.editDraft;
  state.edit = edit ? { messageId: edit.messageId } : null;
  state.mode = edit?.mode || c.mode || "steps";
  state.pendingImages = [...(edit?.images || c.draftImages || [])];
  $("promptInput").value = edit ? edit.text : c.draftText || "";
  renderAttachments(); updateControls();
}
async function setActive(c, internal = false) {
  if (state.submitting && !internal) throw new Error("正在提交问题，请稍等。");
  if (state.assetBusy && !internal) { notice("请先等待当前操作完成。", "error"); return false; }
  await cancelSelection(false);
  if (state.running) { state.running.controller.abort(); await state.running.done; }
  await flushDraft();
  state.current = c;
  if (!state.conversations.some((item) => item.id === c.id)) { state.conversations.push(c); await save(c, false); }
  await chrome.storage.session.set({ ["activeConversation:" + state.windowId]: c.id });
  await chrome.storage.local.set({ activeConversationId: c.id });
  restoreComposer(c); renderMessages(); showView("chat"); notice();
  return true;
}
function isNearBottom() { return $("messages").scrollHeight - $("messages").scrollTop - $("messages").clientHeight < 100; }
function scrollBottom() { $("messages").scrollTop = $("messages").scrollHeight; $("jumpBottomButton").classList.add("hidden"); }
function refreshJump() { $("jumpBottomButton").classList.toggle("hidden", !state.running || isNearBottom()); }

function renderMessageBody(el, m) {
  el.classList.toggle("rendered", !!globalThis.answerRenderer);
  if (globalThis.answerRenderer) {
    try { el.innerHTML = answerRenderer.render(m.content); } catch { el.textContent = m.content; el.classList.remove("rendered"); }
  } else el.textContent = m.content;
}
function renderMessages() {
  const root = $("messages"); root.replaceChildren();
  if (!state.current?.messages.length) {
    const empty = document.createElement("div"); empty.className = "empty";
    empty.innerHTML = '<div class="empty-kicker">YOUR STUDY SPACE</div><h1>从一道题开始。</h1><p>框选网页上的题目，或粘贴一张图片。<br>解题、梳理思路，然后继续追问。</p><div class="empty-actions"></div>';
    empty.querySelector(".empty-actions").append(makeButton("框选一道题", "", () => selectOnPage()), makeButton("添加图片", "", () => $("imageFileInput").click()));
    root.append(empty);
  } else for (const m of state.current.messages) root.append(messageNode(m));
  updateControls(); scrollBottom();
}
function messageNode(m) {
  const node = document.createElement("article"); node.className = "message " + m.role; node.dataset.messageId = m.id;
  const meta = document.createElement("div"); meta.className = "message-meta";
  meta.textContent = m.role === "user" ? "你" : "DeepSeek" + (m.mode ? " · " + C.MODES[m.mode].label : "");
  const bubble = document.createElement("div"); bubble.className = "bubble";
  const images = C.imagesOf(m);
  if (images.length) {
    const gallery = document.createElement("div"); gallery.className = "message-images";
    images.forEach((src, i) => {
      const b = makeButton("", "message-image-button", () => previewImages(images, i), "查看题目图片 " + (i + 1));
      const image = document.createElement("img"); image.className = "message-image"; image.src = src; image.alt = "题目图片 " + (i + 1); b.append(image); gallery.append(b);
    }); bubble.append(gallery);
  }
  const body = document.createElement("div"); body.className = "message-body"; renderMessageBody(body, m); bubble.append(body);
  node.append(meta, bubble);
  decorateMessage(node, m);
  return node;
}
function decorateMessage(node, m) {
  node.querySelectorAll(".message-note,.message-actions,.typing").forEach((el) => el.remove());
  if (m.status === "streaming") {
    const typing = document.createElement("span"); typing.className = "typing"; typing.setAttribute("aria-hidden", "true"); node.querySelector(".bubble").append(typing);
    const note = document.createElement("div"); note.className = "message-note"; note.textContent = m.content ? "正在回答…" : "正在等待回答…"; node.append(note); return;
  }
  if (m.error || ["stopped", "interrupted", "error"].includes(m.status)) {
    const note = document.createElement("div"); note.className = "message-note";
    note.textContent = m.error?.message || (m.status === "stopped" ? "已停止生成，已收到的内容保留。" : "回答中断，可以重试。");
    node.append(note);
  }
  const actions = document.createElement("div"); actions.className = "message-actions";
  if (m.role === "user") {
    const edit = makeButton("修改提问", "message-action", () => editMessage(m));
    edit.dataset.requiresIdle = "1"; edit.disabled = !!state.running || !!state.assetBusy || state.submitting; actions.append(edit);
  } else {
    if (m.content) actions.append(makeButton("复制回答", "message-action", async () => {
      try { await navigator.clipboard.writeText(m.content); notice("回答已复制。", "success"); } catch { notice("复制失败，可选中文字手动复制。", "error"); }
    }));
    const retry = makeButton(m.status === "done" ? "重新回答" : "重试", "message-action", () => regenerate(m));
    retry.dataset.requiresIdle = "1"; retry.disabled = !!state.running || !!state.assetBusy || state.submitting; actions.append(retry);
  }
  node.append(actions);
}
function updateMessage(m, final = false) {
  const node = $("messages").querySelector('[data-message-id="' + m.id + '"]');
  if (!node) return;
  const follow = isNearBottom();
  renderMessageBody(node.querySelector(".message-body"), m);
  if (final) decorateMessage(node, m);
  if (follow) scrollBottom(); else refreshJump();
}
function queueMessageRender(m) {
  if (state.renderTimer) return;
  state.renderTimer = setTimeout(() => { state.renderTimer = null; updateMessage(m); }, 120);
}

function renderAttachments() {
  const root = $("attachment"); root.replaceChildren(); root.classList.toggle("hidden", !state.pendingImages.length);
  state.pendingImages.forEach((src, index) => {
    const card = document.createElement("div"); card.className = "attachment-card"; card.draggable = true; card.dataset.index = String(index);
    const b = makeButton("", "attachment-preview", () => previewImages(state.pendingImages, index), "预览第 " + (index + 1) + " 张图片");
    const img = document.createElement("img"); img.src = src; img.alt = "题目图片 " + (index + 1); img.draggable = false; b.append(img);
    const number = document.createElement("span"); number.className = "attachment-number"; number.textContent = String(index + 1); b.append(number);
    const remove = makeButton("×", "attachment-remove", async () => { state.pendingImages.splice(index, 1); renderAttachments(); await persistDraft(true); }, "移除第 " + (index + 1) + " 张图片");
    const reorder = document.createElement("div"); reorder.className = "attachment-reorder";
    const left = makeButton("‹", "", () => moveImage(index, index - 1), "将第 " + (index + 1) + " 张图片前移");
    const right = makeButton("›", "", () => moveImage(index, index + 1), "将第 " + (index + 1) + " 张图片后移");
    left.dataset.moveTo = String(index - 1); right.dataset.moveTo = String(index + 1);
    left.disabled = index === 0 || !!state.assetBusy; right.disabled = index === state.pendingImages.length - 1 || !!state.assetBusy;
    reorder.append(left, right); card.append(b, remove, reorder);
    card.ondragstart = (event) => { state.draggedImage = index; event.dataTransfer.setData("application/x-question-image", String(index)); event.dataTransfer.effectAllowed = "move"; };
    card.ondragend = () => { state.draggedImage = null; $("composeForm").classList.remove("dragging"); };
    card.ondragover = (event) => { if (state.draggedImage != null) { event.preventDefault(); event.stopPropagation(); } };
    card.ondrop = (event) => {
      if (state.draggedImage == null) return;
      event.preventDefault(); event.stopPropagation(); const from = state.draggedImage; state.draggedImage = null; run(() => moveImage(from, index));
    };
    root.append(card);
  });
  if (state.pendingImages.length) {
    const footer = document.createElement("div"); footer.className = "attachment-footer";
    const count = document.createElement("span"); count.textContent = state.pendingImages.length + " / 4 · 可拖动排序";
    footer.append(count, makeButton("清空图片", "text-button", async () => { state.pendingImages = []; renderAttachments(); await persistDraft(true); }));
    root.append(footer);
  }
  updateControls();
}
async function moveImage(from, to) {
  if (state.assetBusy || state.submitting || from < 0 || from >= state.pendingImages.length || to < 0 || to >= state.pendingImages.length) return;
  const image = state.pendingImages.splice(from, 1)[0]; state.pendingImages.splice(to, 0, image);
  renderAttachments(); await persistDraft(true);
}
async function addImage(src) {
  if (state.pendingImages.length >= C.MAX_IMAGES) throw new Error("每次最多添加 4 张图片，请先发送或移除一张。");
  state.pendingImages.push(src); renderAttachments(); await persistDraft(true);
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ""; reject(new Error("图片读取超时，请重新添加。")); }, 10000);
    img.onload = () => { clearTimeout(timer); img.naturalWidth && img.naturalHeight ? resolve(img) : reject(new Error("图片尺寸无效。")); };
    img.onerror = () => { clearTimeout(timer); reject(new Error("图片损坏或格式不支持，请重新添加。")); };
    img.src = src;
  });
}
function encodeCanvas(source) {
  let canvas = source;
  if (canvas.width > 8192 || canvas.height > 8192) {
    const ratio = 8192 / Math.max(canvas.width, canvas.height), scaled = document.createElement("canvas");
    scaled.width = Math.max(1, Math.round(canvas.width * ratio)); scaled.height = Math.max(1, Math.round(canvas.height * ratio));
    scaled.getContext("2d").drawImage(canvas, 0, 0, scaled.width, scaled.height); canvas = scaled;
  }
  const png = canvas.toDataURL("image/png"); if (png.length <= 4 * 1024 * 1024) return png;
  const flat = document.createElement("canvas"); flat.width = canvas.width; flat.height = canvas.height;
  const ctx = flat.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, flat.width, flat.height); ctx.drawImage(canvas, 0, 0);
  for (const quality of [.92, .85, .75]) { const jpeg = flat.toDataURL("image/jpeg", quality); if (jpeg.length <= 5 * 1024 * 1024) return jpeg; }
  throw new Error("图片过大，请框选更小的题目区域后添加。");
}
function imageWarning(canvas) {
  if (Math.min(canvas.width, canvas.height) < 48) return "图片选区较小，题目可能不清晰；可放大页面后重截。";
  const sample = document.createElement("canvas"); sample.width = 64; sample.height = 64;
  const context = sample.getContext("2d", { willReadFrequently: true }); context.drawImage(canvas, 0, 0, 64, 64);
  const pixels = context.getImageData(0, 0, 64, 64).data; let black = 0, white = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] < 15 && pixels[i + 1] < 15 && pixels[i + 2] < 15) black++;
    if (pixels[i] > 248 && pixels[i + 1] > 248 && pixels[i + 2] > 248) white++;
  }
  if (black / 4096 > .98) return "截图几乎全黑，可能是受保护画面；请先预览再发送。";
  if (white / 4096 > .995) return "截图似乎是空白区域；请先预览再发送。";
  return "";
}
async function importImages(files) {
  if (!state.ready || state.assetBusy || state.selection || state.submitting) { notice("请先完成当前图片操作。", "error"); return; }
  if (!files.length) return;
  state.assetBusy = "import"; updateControls();
  let count = 0; const errors = [];
  try {
    for (const file of files) {
      if (state.pendingImages.length >= C.MAX_IMAGES) { errors.push("已达到 4 张上限，其余文件未添加"); break; }
      try {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) && !(file.type === "" && /\.(png|jpe?g|webp|gif)$/i.test(file.name))) throw new Error("支持 PNG、JPEG、WebP 和 GIF 图片");
        if (file.size > 20 * 1024 * 1024) throw new Error("单张图片请小于 20 MB");
        const url = URL.createObjectURL(file);
        try {
          const image = await loadImage(url);
          if (image.width * image.height > 80000000) throw new Error("图片尺寸过大，请先缩小");
          const ratio = Math.min(1, 4096 / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          await addImage(encodeCanvas(canvas)); count++;
        } finally { URL.revokeObjectURL(url); }
      } catch (error) { errors.push((file.name || "图片") + "：" + error.message); }
    }
    if (errors.length) notice((count ? "已添加 " + count + " 张。 " : "") + errors.join("；"), "error");
    else notice("已添加 " + count + " 张图片。", "success");
  } finally { state.assetBusy = ""; $("imageFileInput").value = ""; updateControls(); focusComposer(); }
}

function previewImages(images, index = 0) {
  if (!images.length) return;
  state.preview = { images: [...images], index }; $("previewZoom").value = "fit"; showView("preview"); renderPreview();
}
function renderPreview() {
  const p = state.preview; if (!p) return;
  const image = $("fullPreviewImage"); image.src = p.images[p.index]; image.classList.remove("original-size");
  image.style.width = ""; image.style.maxWidth = "100%";
  $("previewCount").textContent = (p.index + 1) + " / " + p.images.length;
  $("previousImageButton").disabled = p.index === 0; $("nextImageButton").disabled = p.index === p.images.length - 1;
  $("imagePreviewStage").scrollTop = 0; $("imagePreviewStage").scrollLeft = 0;
  image.onload = applyPreviewZoom;
}
function applyPreviewZoom() {
  const image = $("fullPreviewImage"), zoom = $("previewZoom").value;
  image.style.maxWidth = zoom === "fit" ? "100%" : "none";
  image.style.width = zoom === "fit" ? "" : Math.round(image.naturalWidth * Number(zoom)) + "px";
  image.style.cursor = zoom === "fit" ? "zoom-in" : "zoom-out";
}
function movePreview(amount) {
  if (!state.preview) return; state.preview.index = Math.max(0, Math.min(state.preview.images.length - 1, state.preview.index + amount)); renderPreview();
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function safeName(value) { return (value || "题解").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80); }

function renderHistory() {
  const root = $("historyList"); root.replaceChildren();
  const query = $("historySearch").value.trim().toLowerCase();
  const items = [...state.conversations].filter((c) => !query || (c.title + "\n" + c.messages.map((m) => m.content).join("\n")).toLowerCase().includes(query)).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!items.length) { const text = document.createElement("p"); text.className = "history-empty"; text.textContent = query ? "没有找到匹配的对话" : "还没有历史对话"; root.append(text); }
  for (const c of items) {
    const row = document.createElement("div"); row.className = "history-item" + (state.current?.id === c.id ? " current" : "");
    row.dataset.conversationId = c.id;
    const open = makeButton("", "history-open", () => setActive(c)); open.disabled = !!state.assetBusy;
    const title = document.createElement("strong"); title.textContent = c.title;
    const date = document.createElement("small"); date.textContent = new Date(c.updatedAt).toLocaleString("zh-CN") + " · " + c.messages.length + " 条";
    open.append(title, date);
    const rename = makeButton("命名", "history-rename", () => {
      const input = document.createElement("input"); input.className = "history-title-input"; input.value = c.title; input.maxLength = 120;
      open.replaceWith(input); input.focus(); input.select(); let finished = false;
      const commit = async () => { if (finished) return; finished = true; c.title = input.value.trim() || c.title; await save(c); renderHistory(); updateControls(); };
      input.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); run(commit); } if (e.key === "Escape") { finished = true; renderHistory(); } };
      input.onblur = () => run(commit);
    });
    const remove = makeButton("×", "history-delete", () => askConfirm("删除对话", "删除“" + c.title + "”及其截图？删除后只能从备份恢复。", "history", () => deleteConversation(c)), "删除 " + c.title);
    row.append(open, rename, remove); root.append(row);
  }
}
function askConfirm(title, description, returnView, action) {
  state.confirm = { returnView, action };
  $("confirmTitle").textContent = title; $("confirmDescription").textContent = description; $("confirmActionButton").textContent = title;
  showView("confirm");
}
function cancelConfirm() { const view = state.confirm?.returnView || "chat"; state.confirm = null; showView(view); }
async function deleteConversation(c) {
  if (state.assetBusy || state.submitting) throw new Error("请等待当前操作完成后再删除。");
  state.assetBusy = "delete"; updateControls();
  try {
  if (state.current?.id === c.id) {
    await cancelSelection(false);
    if (state.running) { state.running.controller.abort(); await state.running.done; }
    clearTimeout(state.draftTimer); state.draftTimer = null;
  }
  await state.saveChain.catch(() => {}); await Store.remove(c.id);
  state.conversations = state.conversations.filter((item) => item.id !== c.id);
  if (state.current?.id === c.id) {
    await chrome.storage.local.remove(recoveryKey()); state.current = null;
    await setActive([...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0] || C.newConversation(), true);
  }
  state.confirm = null; showView("history"); notice("对话已删除。", "success");
  } finally { state.assetBusy = ""; updateControls(); if (state.view === "history") renderHistory(); }
}

function captureError(error, tab) {
  const raw = error?.message || "";
  if (/activeTab|invoked|permission|not allowed|Cannot access/i.test(raw)) {
    if (tab?.url?.startsWith("file:")) return new Error("本地 PDF 需要文件访问权限。请在设置中打开扩展权限设置，开启“允许访问文件 URL”。");
    return new Error("当前页面还未授权截图，请回到题目页按截图快捷键，或点击工具栏的扩展图标后重试。");
  }
  return new Error(raw || "截图失败，请重试。");
}
async function activeTab(target) {
  const [tab] = await chrome.tabs.query(target ? { active: true, windowId: target.windowId } : { active: true, currentWindow: true });
  if (tab?.id == null || tab?.windowId == null) throw new Error("找不到当前题目标签页。");
  if (target && (tab.id !== target.tabId || (target.url && tab.url && target.url !== tab.url))) throw new Error("题目页面已切换或刷新，请重新截图。");
  return tab;
}
async function takeScreenshot(target) {
  const tab = await activeTab(target);
  const wait = Math.max(0, 600 - (Date.now() - state.lastCaptureAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  state.lastCaptureAt = Date.now();
  try {
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await activeTab({ tabId: tab.id, windowId: tab.windowId, url: tab.url });
    const image = await loadImage(data);
    if (image.width < 10 || image.height < 10) throw new Error("截图尺寸异常，请重试。");
    return image;
  } catch (error) { throw captureError(error, tab); }
}
function clearSelection() {
  if (state.selection?.timer) clearTimeout(state.selection.timer);
  state.selection = null; updateControls();
}
async function cancelSelection(showNotice = true) {
  const selection = state.selection;
  if (!selection) return;
  clearSelection();
  try { await chrome.scripting.executeScript({ target: { tabId: selection.tabId }, func: () => globalThis.__questionSelectionCancel?.() }); } catch {}
  if (showNotice) notice("已取消框选。");
}
async function selectOnPage(target = null) {
  if (!state.ready) return;
  if (state.assetBusy || state.submitting) throw new Error("请等待当前操作完成。");
  if (state.selection) { notice("请在题目页面拖动框选，按 Esc 取消。"); return; }
  if (state.pendingImages.length >= C.MAX_IMAGES) throw new Error("已添加 4 张图片，请先发送或移除一张。");
  const tab = await activeTab(target);
  const selection = { sessionId: C.id(), tabId: tab.id, windowId: tab.windowId, url: tab.url, conversationId: state.current.id, editId: state.edit?.messageId || null };
  state.selection = selection; showView("chat"); updateControls();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: startQuestionSelection, args: [selection.sessionId] });
    if (state.selection !== selection) return;
    selection.timer = setTimeout(() => run(() => cancelSelection()), 95000);
    notice("在题目页面拖动框选，按 Esc 取消。");
  } catch {
    if (state.selection !== selection) return;
    clearSelection();
    await capture("region", { tabId: tab.id, windowId: tab.windowId, url: tab.url });
  }
}
async function completeSelection(selection, payload) {
  state.assetBusy = "capture"; updateControls();
  try {
    if (state.current?.id !== selection.conversationId || (state.edit?.messageId || null) !== selection.editId) throw new Error("对话已切换，请重新框选。");
    const { rect, viewport } = payload;
    if (!rect || !viewport || ![rect.x, rect.y, rect.w, rect.h, viewport.width, viewport.height].every(Number.isFinite) || rect.w < 8 || rect.h < 8 || viewport.width <= 0 || viewport.height <= 0) throw new Error("选区无效，请重新框选。");
    const currentViewport = await chrome.scripting.executeScript({ target: { tabId: selection.tabId }, func: () => ({ width: innerWidth, height: innerHeight, scrollX, scrollY }) });
    const live = currentViewport[0]?.result;
    if (!live || live.width !== viewport.width || live.height !== viewport.height || (viewport.scrollX != null && live.scrollX !== viewport.scrollX) || (viewport.scrollY != null && live.scrollY !== viewport.scrollY)) throw new Error("页面尺寸或位置发生变化，请重新框选。");
    const image = await takeScreenshot({ tabId: selection.tabId, windowId: selection.windowId, url: selection.url });
    const sx = image.width / viewport.width, sy = image.height / viewport.height;
    const x = Math.max(0, Math.min(image.width - 1, Math.floor(rect.x * sx))), y = Math.max(0, Math.min(image.height - 1, Math.floor(rect.y * sy)));
    const right = Math.min(image.width, Math.ceil((rect.x + rect.w) * sx)), bottom = Math.min(image.height, Math.ceil((rect.y + rect.h) * sy));
    if (right <= x || bottom <= y) throw new Error("选区超出页面范围，请重新框选。");
    const canvas = document.createElement("canvas"); canvas.width = right - x; canvas.height = bottom - y;
    canvas.getContext("2d").drawImage(image, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    const warning = imageWarning(canvas);
    await addImage(encodeCanvas(canvas)); focusComposer(); notice(warning || "题目已加入，可以补充要求后发送。", warning ? "error" : "success");
  } finally { state.assetBusy = ""; updateControls(); }
}
async function capture(mode, target = null) {
  if (!state.ready) return;
  if (state.assetBusy || state.selection || state.submitting) throw new Error("请先完成当前操作。");
  if (state.pendingImages.length >= C.MAX_IMAGES) throw new Error("已添加 4 张图片，请先发送或移除一张。");
  state.assetBusy = "capture"; updateControls();
  try {
    const image = await takeScreenshot(target);
    if (mode === "region") {
      state.crop = { image, rect: null, conversationId: state.current.id, editId: state.edit?.messageId || null };
      $("cropHint").textContent = "当前页面不允许直接画选框，请在截图上拖动选择题目。";
      $("zoomInput").value = "1"; showView("crop"); drawCrop(); notice();
    } else {
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height; canvas.getContext("2d").drawImage(image, 0, 0);
      const warning = imageWarning(canvas);
      await addImage(encodeCanvas(canvas)); focusComposer(); notice(warning || "可见页面已加入。", warning ? "error" : "success");
    }
  } finally { state.assetBusy = ""; updateControls(); }
}
function normalizedRect(rect) { return { x: Math.min(rect.x1, rect.x2), y: Math.min(rect.y1, rect.y2), w: Math.abs(rect.x1 - rect.x2), h: Math.abs(rect.y1 - rect.y2) }; }
function drawCrop() {
  if (!state.crop) return;
  const canvas = $("cropCanvas"), image = state.crop.image;
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  const rect = state.crop.rect ? normalizedRect(state.crop.rect) : null;
  if (rect) {
    context.fillStyle = "rgba(0,0,0,.1)"; context.fillRect(rect.x, rect.y, rect.w, rect.h);
    context.strokeStyle = "#444"; context.lineWidth = Math.max(2, canvas.width / 500); context.strokeRect(rect.x, rect.y, rect.w, rect.h);
  }
  canvas.style.width = Number($("zoomInput").value) * 100 + "%";
  $("zoomLabel").textContent = Math.round(Number($("zoomInput").value) * 100) + "%";
  $("useCropButton").disabled = !rect || rect.w < 8 || rect.h < 8 || !!state.assetBusy;
}
function cropPoint(event) {
  const canvas = $("cropCanvas"), rect = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)), y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)) };
}
async function useCrop(full = false) {
  const crop = state.crop;
  if (!crop || state.assetBusy) return;
  if (crop.conversationId !== state.current?.id || crop.editId !== (state.edit?.messageId || null)) throw new Error("对话已切换，请重新截图。");
  const rect = full ? { x: 0, y: 0, w: crop.image.width, h: crop.image.height } : crop.rect && normalizedRect(crop.rect);
  if (!rect || rect.w < 8 || rect.h < 8) return;
  state.assetBusy = "crop"; updateControls();
  try {
    const canvas = document.createElement("canvas"); canvas.width = Math.ceil(rect.w); canvas.height = Math.ceil(rect.h);
    canvas.getContext("2d").drawImage(crop.image, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    const warning = imageWarning(canvas);
    await addImage(encodeCanvas(canvas)); focusComposer(); notice(warning || "题目已加入。", warning ? "error" : "success");
  } finally { state.assetBusy = ""; updateControls(); }
}

async function editMessage(message) {
  if (state.running || state.assetBusy || state.selection) throw new Error("请先完成当前操作，再修改提问。");
  if (state.edit && state.edit.messageId !== message.id) throw new Error("请先发送或取消当前正在修改的提问。");
  await flushDraft();
  state.edit = { messageId: message.id }; state.pendingImages = [...C.imagesOf(message)];
  state.mode = message.mode || state.current.mode; $("promptInput").value = message.content;
  renderAttachments(); await persistDraft(true); focusComposer();
}
async function cancelEdit() {
  if (!state.edit) return;
  state.edit = null; delete state.current.editDraft;
  restoreComposer(state.current); await save(state.current); await chrome.storage.local.remove(recoveryKey()); focusComposer();
}
async function sendMessage() {
  if (!state.ready || state.running || state.assetBusy || state.selection || state.submitting) return;
  if (!state.key) { await flushDraft(); showView("settings"); notice("先填写自己的 DeepSeek API Key。", "error"); return; }
  const text = $("promptInput").value.trim(), images = [...state.pendingImages], mode = state.mode;
  if (!text && !images.length) return;
  const requestKey = state.key; state.submitting = true; updateControls();
  try {
  await persistDraft(true);
  // Lock before any later asynchronous write so repeated clicks cannot send twice.
  if (state.running) return;
  let c = state.current;
  if (state.edit) {
    const source = c;
    c = C.branchConversation(source, state.edit.messageId, "edit", { text, images });
    c.mode = mode; delete source.editDraft; await save(source);
    state.current = c; state.conversations.push(c); state.edit = null;
    await chrome.storage.session.set({ ["activeConversation:" + state.windowId]: c.id });
    await chrome.storage.local.set({ activeConversationId: c.id });
  }
  c.mode = mode;
  const user = { id: C.id(), role: "user", content: text || "请解答图片中的题目。", images, mode, status: "done", createdAt: Date.now() };
  c.messages.push(user);
  if (c.title === "新对话") c.title = text ? text.slice(0, 40) : "截图题目";
  c.draftText = ""; c.draftImages = []; delete c.editDraft; state.pendingImages = []; $("promptInput").value = ""; renderAttachments();
  clearTimeout(state.draftTimer); state.draftTimer = null;
  await chrome.storage.local.remove(recoveryKey()).catch(reportError);
  await generateAnswer(c, [...c.messages], mode, requestKey);
  } finally { state.submitting = false; updateControls(); }
}
async function regenerate(message) {
  if (state.running || state.assetBusy || state.selection || state.submitting) throw new Error("请先完成当前操作。");
  if (state.edit) throw new Error("请先发送或取消当前修改，再重新回答。");
  if (!state.key) { showView("settings"); notice("先填写 DeepSeek API Key。", "error"); return; }
  const requestKey = state.key; state.submitting = true; updateControls();
  try {
  await flushDraft();
  const c = C.branchConversation(state.current, message.id, "retry", {});
  c.mode = state.mode;
  if (!c.messages.length || c.messages.at(-1).role !== "user") throw new Error("原提问不完整，无法重试。");
  await setActive(c, true);
  await generateAnswer(c, [...c.messages], c.mode, requestKey);
  } finally { state.submitting = false; updateControls(); }
}
async function generateAnswer(c, context, mode, requestKey = state.key) {
  if (state.running) return;
  let done;
  const controller = new AbortController(), completion = new Promise((resolve) => { done = resolve; });
  state.running = { controller, done: completion, conversationId: c.id };
  const message = { id: C.id(), role: "assistant", content: "", mode, status: "streaming", createdAt: Date.now() };
  c.messages.push(message); renderMessages(); notice();
  try {
    await save(c);
    await Api.stream(requestKey, C.buildMessages(C.copy(context), mode), (delta) => {
      message.content += delta; queueMessageRender(message);
      if (!state.streamSaveTimer) state.streamSaveTimer = setTimeout(() => { state.streamSaveTimer = null; save(c).catch(reportError); }, 500);
    }, controller.signal);
    if (!message.content.trim()) throw new Api.RequestError("empty", "没有收到回答，请点击重试。");
    message.status = "done";
  } catch (error) {
    message.status = error.name === "AbortError" ? "stopped" : "error";
    message.error = { code: error.name === "AbortError" ? "stopped" : error.code || "error", message: error.name === "AbortError" ? "已停止生成，已收到的内容保留。" : error.message };
    if (error.name !== "AbortError") reportError(error);
  } finally {
    clearTimeout(state.renderTimer); state.renderTimer = null;
    clearTimeout(state.streamSaveTimer); state.streamSaveTimer = null;
    try { await save(c); } catch (error) { reportError(error); }
    state.running = null; updateMessage(message, true); updateControls();
    for (const m of c.messages) { const node = $("messages").querySelector('[data-message-id="' + m.id + '"]'); if (node) decorateMessage(node, m); }
    done();
  }
}

async function backup(all = true) {
  if (state.running || state.assetBusy || state.selection || state.submitting) throw new Error("请等当前操作结束，或先停止生成后再备份。");
  await flushDraft();
  const conversations = all ? (await Store.all()).map((c) => C.normalizeConversation(c)) : [state.current];
  const text = JSON.stringify(C.makeBackup(conversations), null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  if (blob.size > C.MAX_BACKUP_BYTES) throw new Error("完整备份超过 256 MB，请分别备份各个对话。");
  const day = new Date().toLocaleDateString("sv-SE");
  downloadBlob(blob, (all ? "题解侧栏-完整备份-" : safeName(state.current.title) + "-备份-") + day + ".json");
  notice("完整备份已下载，包含截图和草稿。", "success");
}
async function exportMarkdown() {
  await flushDraft();
  if (!state.current?.messages.length) throw new Error("当前对话还没有消息。");
  const text = "# " + state.current.title + "\n\n" + state.current.messages.map((m) => "## " + (m.role === "user" ? "提问" : "回答") + "\n\n" + m.content + (C.imagesOf(m).length ? "\n\n（附图 " + C.imagesOf(m).length + " 张；图片包含在完整备份中。）" : "") + (m.error ? "\n\n> " + m.error.message : "")).join("\n\n---\n\n");
  downloadBlob(new Blob([text], { type: "text/markdown;charset=utf-8" }), safeName(state.current.title) + ".md");
  notice("文字记录已导出。", "success");
}
async function prepareRestore(file) {
  if (!file) return;
  if (state.running || state.assetBusy || state.selection || state.submitting) throw new Error("请先完成当前操作，再恢复备份。");
  if (file.size > C.MAX_BACKUP_BYTES) throw new Error("备份文件不能超过 256 MB。");
  state.restoreData = null; state.assetBusy = "restore"; updateControls(); notice("正在检查备份文件…");
  try {
    const incoming = C.parseBackup(await file.text());
    const images = [...new Set(incoming.flatMap((c) => [...c.draftImages, ...(c.editDraft?.images || []), ...c.messages.flatMap(C.imagesOf)]))];
    for (const src of images) {
      try { await loadImage(src); } catch { throw new Error("备份中有损坏的图片，尚未导入任何记录。"); }
    }
    const existing = (await Store.all()).map((c) => C.normalizeConversation(c));
    const plan = C.planRestore(incoming, existing);
    state.restoreData = incoming;
    $("restoreSummary").textContent = incoming.length + " 个对话，" + images.length + " 张图片：新增 " + plan.newCount + " 个，冲突副本 " + plan.conflictCount + " 个，相同记录跳过 " + plan.duplicateCount + " 个。";
    $("confirmRestoreButton").disabled = !plan.additions.length;
    showView("restore"); notice();
  } finally { state.assetBusy = ""; $("backupFileInput").value = ""; updateControls(); }
}
async function confirmRestore() {
  if (!state.restoreData || state.assetBusy) return;
  state.assetBusy = "restore"; $("confirmRestoreButton").disabled = true; updateControls();
  try {
    await flushDraft();
    const existing = (await Store.all()).map((c) => C.normalizeConversation(c));
    const plan = C.planRestore(state.restoreData, existing);
    await Store.putMany(plan.additions);
    state.conversations = (await Store.all()).map((c) => C.normalizeConversation(c));
    state.current = state.conversations.find((c) => c.id === state.current?.id) || state.conversations[0] || C.newConversation();
    restoreComposer(state.current); renderMessages(); showView("history");
    notice("已恢复 " + plan.additions.length + " 个对话，相同记录跳过 " + plan.duplicateCount + " 个。", "success");
  } finally { state.assetBusy = ""; updateControls(); if (state.view === "history") renderHistory(); }
}
async function clearHistory() {
  if (state.assetBusy || state.submitting) throw new Error("请等待当前操作完成。");
  state.assetBusy = "clear"; updateControls();
  try {
  await cancelSelection(false);
  if (state.running) { state.running.controller.abort(); await state.running.done; }
  clearTimeout(state.draftTimer); state.draftTimer = null;
  await state.saveChain.catch(() => {}); await Store.clear();
  await chrome.storage.local.remove(recoveryKey());
  state.conversations = []; state.current = null; state.edit = null; state.pendingImages = []; $("promptInput").value = "";
  await setActive(C.newConversation(), true); state.confirm = null; showView("settings"); notice("全部对话已清空。", "success");
  } finally { state.assetBusy = ""; updateControls(); }
}
async function checkConnection() {
  if (state.checkAbort) { state.checkAbort.abort(); return; }
  const key = $("apiKeyInput").value.trim();
  if (!key || /\s/.test(key)) throw new Api.RequestError("key", "请填写 API Key，Key 中不能包含空格或换行。");
  const controller = new AbortController(); state.checkAbort = controller;
  $("checkConnectionButton").textContent = "取消检测"; $("apiConnectionStatus").textContent = "正在检查连接…"; $("apiConnectionStatus").className = "connection-status";
  try {
    const result = await Api.check(key, controller.signal);
    if (!result.data.length) throw new Api.RequestError("model", "Key 已通过验证，但账户未返回可用模型。");
    $("apiConnectionStatus").textContent = "连接正常，Key 已通过验证。余额以官方平台为准。";
    $("apiConnectionStatus").classList.add("success");
  } catch (error) {
    $("apiConnectionStatus").textContent = error.name === "AbortError" ? "检测已取消。" : error.message;
    $("apiConnectionStatus").classList.toggle("error", error.name !== "AbortError");
  } finally { state.checkAbort = null; $("checkConnectionButton").textContent = "检查连接"; }
}
async function refreshShortcutLabel() {
  const commands = await chrome.commands.getAll(), shortcut = commands.find((c) => c.name === "capture-question")?.shortcut;
  $("shortcutLabel").textContent = shortcut || "尚未分配";
  $("regionButton").title = shortcut ? "框选题目 · " + shortcut : "直接在网页框选题目";
}
async function consumeShortcut(request) {
  if (!state.ready || !request || request.windowId !== state.windowId || request.id === state.lastShortcutId) return;
  state.lastShortcutId = request.id;
  const key = "captureShortcut:" + state.windowId, stored = await chrome.storage.session.get(key);
  if (stored[key]?.id === request.id) await chrome.storage.session.remove(key);
  if (Date.now() - request.createdAt > 15000) return;
  showView("chat"); await selectOnPage({ tabId: request.tabId, windowId: request.windowId });
}
async function openTab(url) { await chrome.tabs.create({ url }); }
function applyFont(size) {
  const valid = ["13", "15", "17"].includes(String(size)) ? String(size) : "13";
  document.documentElement.style.setProperty("--reading-size", valid + "px"); $("fontSizeSelect").value = valid;
}

async function init() {
  const currentWindow = await chrome.windows.getCurrent(); state.windowId = currentWindow.id;
  const stored = await chrome.storage.local.get(["deepseekApiKey", "activeConversationId", "readingFontSize", recoveryKey()]);
  const session = await chrome.storage.session.get(["activeConversation:" + state.windowId, "captureShortcut:" + state.windowId]);
  state.key = stored.deepseekApiKey || ""; applyFont(stored.readingFontSize);
  const raw = await Store.all(), migrated = [];
  for (const value of raw) {
    const c = C.normalizeConversation(value); state.conversations.push(c);
    if (JSON.stringify(c) !== JSON.stringify(value)) migrated.push(c);
  }
  if (migrated.length) await Store.putMany(migrated);
  const activeId = session["activeConversation:" + state.windowId] || stored.activeConversationId;
  state.current = state.conversations.find((c) => c.id === activeId) || [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0] || C.newConversation();
  if (!state.conversations.some((c) => c.id === state.current.id)) { state.conversations.push(state.current); await save(state.current, false); }
  const recovery = stored[recoveryKey()];
  if (recovery?.conversationId === state.current.id && recovery.updatedAt > state.current.updatedAt && typeof recovery.text === "string") {
    const c = state.current;
    if (recovery.messageId && c.messages.some((m) => m.id === recovery.messageId && m.role === "user")) {
      c.editDraft = { messageId: recovery.messageId, text: recovery.text, images: c.editDraft?.images || C.imagesOf(c.messages.find((m) => m.id === recovery.messageId)), mode: C.MODES[recovery.mode] ? recovery.mode : c.mode };
    } else { c.draftText = recovery.text; c.mode = C.MODES[recovery.mode] ? recovery.mode : c.mode; }
    await save(c);
  }
  await chrome.storage.session.set({ ["activeConversation:" + state.windowId]: state.current.id });
  $("appVersion").textContent = C.VERSION; state.ready = true; restoreComposer(state.current); renderMessages();
  if (!state.key) notice("填入自己的 DeepSeek API Key 后即可开始。", "", { label: "打开设置", run: () => showView("settings") });
  await refreshShortcutLabel(); await consumeShortcut(session["captureShortcut:" + state.windowId]);
}

$("historyButton").onclick = () => showView("history");
$("newButton").onclick = () => run(() => setActive(C.newConversation()));
$("settingsButton").onclick = () => showView("settings");
for (const b of document.querySelectorAll("[data-back]")) b.onclick = () => showView(b.dataset.back);
$("sourceConversationButton").onclick = () => run(() => {
  const c = state.conversations.find((item) => item.id === state.current?.branchSource?.conversationId);
  if (c) return setActive(c); throw new Error("源对话已经删除。");
});
$("regionButton").onclick = () => run(() => selectOnPage());
$("screenButton").onclick = () => run(() => capture("screen"));
$("uploadButton").onclick = () => $("imageFileInput").click();
$("imageFileInput").onchange = (event) => run(() => importImages([...event.target.files]));
$("useCropButton").onclick = () => run(() => useCrop());
$("useScreenButton").onclick = () => run(() => useCrop(true));
$("zoomInput").oninput = drawCrop;
$("cropCanvas").onpointerdown = (e) => {
  if (!state.crop || e.button !== 0) return;
  const p = cropPoint(e); state.crop.rect = { x1: p.x, y1: p.y, x2: p.x, y2: p.y }; state.crop.dragging = true; $("cropCanvas").setPointerCapture(e.pointerId); drawCrop();
};
$("cropCanvas").onpointermove = (e) => {
  if (!state.crop?.dragging) return;
  const p = cropPoint(e); state.crop.rect.x2 = p.x; state.crop.rect.y2 = p.y; drawCrop();
};
for (const type of ["pointerup", "pointercancel"]) $("cropCanvas").addEventListener(type, () => { if (state.crop) state.crop.dragging = false; drawCrop(); });
$("composeForm").onsubmit = (e) => { e.preventDefault(); run(sendMessage); };
$("promptInput").oninput = () => { persistDraft().catch(reportError); updateControls(); };
$("promptInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); run(sendMessage); } };
$("modeSelect").onchange = () => { state.mode = C.MODES[$("modeSelect").value] ? $("modeSelect").value : "steps"; persistDraft(true).catch(reportError); updateControls(); };
$("cancelEditButton").onclick = () => run(cancelEdit);
$("stopButton").onclick = () => state.running?.controller.abort();
$("messages").onscroll = refreshJump;
$("jumpBottomButton").onclick = scrollBottom;
$("historySearch").oninput = renderHistory;
$("previousImageButton").onclick = () => movePreview(-1);
$("nextImageButton").onclick = () => movePreview(1);
$("previewZoom").onchange = applyPreviewZoom;
$("fullPreviewImage").onclick = () => { $("previewZoom").value = $("previewZoom").value === "fit" ? "1" : "fit"; applyPreviewZoom(); };
$("downloadImageButton").onclick = () => {
  if (!state.preview) return;
  const src = state.preview.images[state.preview.index], link = document.createElement("a");
  const mime = /^data:image\/(\w+)/.exec(src)?.[1];
  link.href = src; link.download = "题目-" + (state.preview.index + 1) + ({ jpeg: ".jpg", gif: ".gif", webp: ".webp" }[mime] || ".png"); link.click();
};
$("exportButton").onclick = () => showView("export");
$("exportMarkdownButton").onclick = () => run(exportMarkdown);
$("backupCurrentButton").onclick = () => run(() => backup(false));
$("backupAllButton").onclick = () => run(() => backup(true));
$("restoreBackupButton").onclick = () => $("backupFileInput").click();
$("backupFileInput").onchange = (e) => run(() => prepareRestore(e.target.files[0]));
$("confirmRestoreButton").onclick = () => run(confirmRestore);
$("clearHistoryButton").onclick = () => askConfirm("清空全部对话", "清空全部对话、截图和草稿？此操作不能撤销。建议先下载完整备份。API Key 单独保留。", "settings", clearHistory);
$("cancelConfirmButton").onclick = cancelConfirm; $("cancelConfirmHeader").onclick = cancelConfirm;
$("confirmActionButton").onclick = () => run(async () => {
  const pending = state.confirm; if (!pending) return; $("confirmActionButton").disabled = true;
  try { await pending.action(); } finally { $("confirmActionButton").disabled = false; }
});
$("settingsForm").onsubmit = (e) => {
  e.preventDefault(); run(async () => {
    const key = $("apiKeyInput").value.trim();
    if (!key || /\s/.test(key)) throw new Api.RequestError("key", "Key 不能为空，也不能包含空格或换行。");
    await chrome.storage.local.set({ deepseekApiKey: key }); state.key = key; showView("chat"); notice("API Key 已保存。", "success");
  });
};
$("checkConnectionButton").onclick = () => run(checkConnection);
$("toggleKeyButton").onclick = () => {
  const input = $("apiKeyInput"); input.type = input.type === "password" ? "text" : "password"; $("toggleKeyButton").textContent = input.type === "password" ? "显示" : "隐藏";
};
$("apiKeyInput").oninput = () => { $("apiConnectionStatus").textContent = "尚未检测"; $("apiConnectionStatus").className = "connection-status"; };
$("clearKeyButton").onclick = () => run(async () => {
  state.checkAbort?.abort(); await chrome.storage.local.remove("deepseekApiKey"); state.key = ""; $("apiKeyInput").value = "";
  $("apiConnectionStatus").textContent = "Key 已移除"; $("apiConnectionStatus").className = "connection-status"; notice("已移除 API Key。", "success");
});
$("fontSizeSelect").onchange = () => run(async () => { applyFont($("fontSizeSelect").value); await chrome.storage.local.set({ readingFontSize: $("fontSizeSelect").value }); });
$("openExtensionDetailsButton").onclick = () => run(() => openTab("edge://extensions/?id=" + chrome.runtime.id));
$("changeShortcutButton").onclick = () => run(() => openTab("edge://extensions/shortcuts"));
$("openDownloadButton").onclick = () => run(() => openTab("https://github.com/bixike3-droid/edge-question-assistant/releases/latest"));
document.addEventListener("paste", (e) => {
  if (state.view !== "chat") return;
  const images = [...(e.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
  if (images.length) { e.preventDefault(); run(() => importImages(images)); }
});
const dropZone = $("composeForm");
for (const type of ["dragenter", "dragover"]) dropZone.addEventListener(type, (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault(); dropZone.classList.add("dragging");
});
dropZone.ondragleave = (e) => { if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("dragging"); };
dropZone.ondrop = (e) => {
  dropZone.classList.remove("dragging");
  if (state.draggedImage != null) { e.preventDefault(); state.draggedImage = null; return; }
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); run(() => importImages([...e.dataTransfer.files]));
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.selection) { e.preventDefault(); run(() => cancelSelection()); }
    else if (state.view === "confirm") cancelConfirm();
    else if (state.view !== "chat") showView("chat");
  }
  if (state.view === "preview" && !["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) && ["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); movePreview(e.key === "ArrowLeft" ? -1 : 1); }
});
chrome.runtime.onMessage.addListener((message, sender) => {
  const selection = state.selection;
  if (!selection || message?.sessionId !== selection.sessionId || sender.tab?.id !== selection.tabId) return;
  if (message.type === "question-selection-cancel") { clearSelection(); notice("已取消框选。"); }
  if (message.type === "question-selection-done") { clearSelection(); run(() => completeSelection(selection, message)); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && state.ready) {
    const request = changes["captureShortcut:" + state.windowId]?.newValue;
    if (request) run(() => consumeShortcut(request));
  }
  if (area === "local" && changes.deepseekApiKey) state.key = changes.deepseekApiKey.newValue || "";
});
window.addEventListener("pagehide", () => { if (state.ready) persistDraft(true).catch(() => {}); });
document.addEventListener("visibilitychange", () => { if (document.hidden && state.ready) persistDraft(true).catch(() => {}); });
window.addEventListener("offline", () => notice("当前网络已断开，联网后可以重试。", "error"));
init().catch(reportError);
