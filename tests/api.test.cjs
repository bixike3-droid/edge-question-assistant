const test = require("node:test"), assert = require("node:assert/strict");
const A = require("../api.js");
const key = "test-only";
function response(chunks, options = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk); if (!options.hold) controller.close(); }, cancel() { options.onCancel?.(); } }), { status: 200 });
}
const data = (value) => "data: " + JSON.stringify({ choices: [{ delta: { content: value } }] }) + "\r\n\r\n";
test("SSE survives UTF-8 and CRLF boundaries, heartbeat comments and trailing DONE", async () => {
  const encoded = new TextEncoder().encode(data("第一步") + data("：答案") + "data: [DONE]");
  const chunks = [...encoded].map(byte => new Uint8Array([byte]));
  let text = "", cancelled = false, request;
  await A.stream(key, [{ role: "user", content: "hi" }], delta => text += delta, undefined, {
    fetcher: async (url, options) => { request = { url, options }; return response([": keepalive\n\n", ...chunks], { onCancel() { cancelled = true; } }); }
  });
  assert.equal(text, "第一步：答案");
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(JSON.parse(request.options.body).model, "deepseek-flash");
});
test("HTTP failures receive actionable categories and never echo Key", async () => {
  for (const [status, code] of [[401,"key"],[402,"balance"],[429,"rate_limit"],[503,"service"]]) {
    await assert.rejects(A.stream(key, [], () => {}, undefined, { fetcher: async () => new Response(JSON.stringify({ error: { message: key } }), { status }) }), e => e.code === code && !e.message.includes(key) && !e.detail.includes(key));
  }
});
test("partial interruption and malformed stream are explicit rather than silently accepted", async () => {
  let text = "";
  await assert.rejects(A.stream(key, [], x => text += x, undefined, { fetcher: async () => response([data("partial")]) }), e => e.code === "interrupted");
  assert.equal(text, "partial");
  await assert.rejects(A.stream(key, [], () => {}, undefined, { fetcher: async () => response(["data: {invalid}\n\n"]) }), e => e.code === "format");
});
test("user cancellation cancels a live request", async () => {
  const controller = new AbortController();
  const task = A.stream(key, [], () => {}, controller.signal, { fetcher: async (url, options) => {
    options.signal.addEventListener("abort", () => {});
    return new Response(new ReadableStream({ start(c) { options.signal.addEventListener("abort", () => c.error(new DOMException("aborted","AbortError"))); } }));
  } });
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(task, e => e.name === "AbortError");
});
test("header and idle timeouts release waiting instead of remaining busy indefinitely", async () => {
  await assert.rejects(A.stream(key, [], () => {}, undefined, { timing: { headers: 20, total: 100 }, fetcher: (url, options) => new Promise((resolve,reject) => options.signal.addEventListener("abort", () => reject(new DOMException("timeout","AbortError")))) }), e => e.code === "timeout");
  await assert.rejects(A.stream(key, [], () => {}, undefined, { timing: { idle: 20, total: 100 }, fetcher: async (url, options) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": waiting\n\n")); options.signal.addEventListener("abort", () => c.error(new DOMException("timeout","AbortError"))); } })) }), e => e.code === "timeout");
});
test("connection check uses official models endpoint and validates response", async () => {
  let call;
  const result = await A.check(key, undefined, { fetcher: async (url, options) => { call = { url, options }; return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] })); } });
  assert.equal(call.url, "https://api.deepseek.com/models"); assert.equal(call.options.method, "GET"); assert.equal(call.options.body, undefined); assert.equal(result.data.length, 1);
  await assert.rejects(A.check(key, undefined, { fetcher: async () => new Response("{}") }), e => e.code === "format");
  await assert.rejects(A.check("bad key"), e => e.code === "key");
});
