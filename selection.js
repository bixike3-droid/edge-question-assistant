"use strict";
function startQuestionSelection(sessionId) {
  globalThis.__questionSelectionCancel?.();
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
    window.removeEventListener("resize", cancel);
    document.removeEventListener("visibilitychange", onVisibility);
    delete globalThis.__questionSelectionCancel;
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
  const onVisibility = () => { if (document.hidden) cancel(); };
  globalThis.__questionSelectionCancel = cancel;
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", cancel);
  document.addEventListener("visibilitychange", onVisibility);
  surface.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
  timeout = setTimeout(cancel, 90000);

  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragging) return;
    event.preventDefault();
    event.stopPropagation();
    origin = { x: clamp(event.clientX, window.innerWidth), y: clamp(event.clientY, window.innerHeight), scrollX: window.scrollX, scrollY: window.scrollY };
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
    if (origin.scrollX !== window.scrollX || origin.scrollY !== window.scrollY) { cancel(); return; }
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
      viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY }
    })));
  });
  surface.addEventListener("pointercancel", cancel);
}

globalThis.startQuestionSelection = startQuestionSelection;
