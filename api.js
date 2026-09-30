"use strict";
(() => {
  class RequestError extends Error {
    constructor(code, message) { super(message); this.name = "RequestError"; this.code = code; }
  }
  function httpError(status, detail = "") {
    const mapping = {
      400: ["invalid_request", "请求内容无法处理。可以减少题目图片或新建对话后重试。"],
      401: ["key", "API Key 无效，请在设置中检查或重新填写。"],
      402: ["balance", "DeepSeek 账户额度不足，请到官方平台查看余额。"],
      403: ["permission", "当前 Key 没有调用权限，请检查官方账户设置。"],
      404: ["model", "当前视觉模型不可用，请更新扩展或稍后重试。"],
      422: ["invalid_request", "接口拒绝了请求参数，请更新扩展后重试。"],
      429: ["rate_limit", "请求过于频繁，请稍等再重试。"],
      500: ["service", "DeepSeek 服务暂时出错，已保留题目，请稍后重试。"],
      503: ["service", "DeepSeek 服务繁忙，已保留题目，请稍后重试。"]
    };
    const [code, message] = mapping[status] || (status === 408 || status === 504 ? ["timeout", "接口等待超时，可以重试。"] : ["service", `接口返回 ${status}，可以稍后重试。`]);
    const error = new RequestError(code, message); error.detail = detail; return error;
  }

  async function request({ key, path, body, signal, onDelta, fetcher = fetch, timing = {} }) {
    if (typeof key !== "string" || !key.trim() || /\s/.test(key)) throw new RequestError("key", "请填写有效的 API Key，Key 中不能包含空格或换行。");
    const controller = new AbortController();
    let timeout = "", headerTimer, idleTimer, totalTimer, reader;
    const abort = () => controller.abort();
    const expire = (kind) => { timeout = kind; controller.abort(); };
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => expire("idle"), timing.idle ?? 90000); };
    if (signal?.aborted) throw new DOMException("已停止", "AbortError");
    signal?.addEventListener("abort", abort, { once: true });
    headerTimer = setTimeout(() => expire("headers"), timing.headers ?? 30000);
    totalTimer = setTimeout(() => expire("total"), timing.total ?? (body ? 300000 : 30000));
    try {
      const response = await fetcher("https://api.deepseek.com" + path, {
        method: body ? "POST" : "GET", headers: { "Authorization": "Bearer " + key, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal
      });
      clearTimeout(headerTimer); resetIdle();
      if (!response.ok) {
        let detail = ""; try { detail = (await response.json()).error?.message || ""; } catch {}
        throw httpError(response.status, detail.replaceAll(key, "[Key]"));
      }
      if (!body) {
        const result = await response.json();
        if (!Array.isArray(result.data)) throw new RequestError("format", "接口返回了异常的模型列表。");
        return result;
      }
      if (!response.body) throw new RequestError("format", "接口没有返回回答数据流，请重试。");
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = "", complete = false;
      const event = (source) => {
        const lines = source.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
        if (!lines.length) return;
        const data = lines.join("\n");
        if (data === "[DONE]") { complete = true; return; }
        let chunk; try { chunk = JSON.parse(data); } catch { throw new RequestError("format", "回答数据格式异常，已保留收到的内容，可以重试。"); }
        if (chunk.error) throw new RequestError("service", "接口中断了回答，已保留收到的内容，可以重试。");
        const choice = chunk.choices?.[0];
        if (typeof choice?.delta?.content === "string") onDelta(choice.delta.content);
        if (choice?.finish_reason === "length") throw new RequestError("length", "回答达到长度上限，已保留内容；可以继续追问剩余部分。");
        if (choice?.finish_reason === "content_filter") throw new RequestError("filtered", "接口无法继续回答当前内容。");
      };
      while (!complete) {
        const { value, done } = await reader.read();
        if (done) { buffer += decoder.decode(); if (buffer.trim()) event(buffer.replace(/\r\n/g, "\n")); break; }
        resetIdle(); buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        let boundary;
        while (!complete && (boundary = buffer.indexOf("\n\n")) >= 0) { event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      }
      if (!complete) throw new RequestError("interrupted", "回答连接提前结束，已保留内容，可以重试。");
    } catch (error) {
      if (timeout) throw new RequestError("timeout", timeout === "total" && body ? "请求超过 5 分钟，已停止等待；题目和已收到内容已保留。" : "接口长时间没有响应，可以检查网络后重试。");
      if (signal?.aborted) throw new DOMException("已停止", "AbortError");
      if (error instanceof RequestError) throw error;
      throw new RequestError("network", "无法连接 DeepSeek，请检查网络后重试。");
    } finally {
      clearTimeout(headerTimer); clearTimeout(idleTimer); clearTimeout(totalTimer);
      signal?.removeEventListener("abort", abort);
      if (reader) { try { await reader.cancel(); } catch {} }
    }
  }
  const api = {
    RequestError, httpError, request,
    stream: (key, messages, onDelta, signal, options = {}) => request({ key, path: "/chat/completions", body: { model: "deepseek-flash", messages, stream: true }, onDelta, signal, ...options }),
    check: (key, signal, options = {}) => request({ key, path: "/models", signal, ...options })
  };
  globalThis.DeepSeekApi = api;
  if (typeof module !== "undefined") module.exports = api;
})();
