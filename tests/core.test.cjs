const test = require("node:test"), assert = require("node:assert/strict");
globalThis.crypto ||= require("node:crypto").webcrypto;
const C = require("../core.js");
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=";
function fixture() {
  const c = C.newConversation("concise");
  c.messages = [{ id: "user", role: "user", content: "question", images: [image], createdAt: 1, status: "done" }, { id: "answer", role: "assistant", content: "partial", createdAt: 2, status: "streaming" }];
  c.draftText = "next question"; c.draftImages = [image];
  return c;
}
test("legacy records retain screenshot and interrupted answer", () => {
  const old = fixture(); old.messages[0].image = image; delete old.messages[0].images; delete old.draftImages;
  const migrated = C.normalizeConversation(old);
  assert.deepEqual(migrated.messages[0].images, [image]); assert.equal(migrated.messages[1].content, "partial");
  assert.equal(migrated.messages[1].status, "interrupted");
});
test("complete backup round-trip includes images, modes and editing draft but excludes credentials", () => {
  const c = fixture(); c.messages[1].status = "done";
  c.editDraft = { messageId: "user", text: "corrected", images: [image], mode: "check" };
  c.deepseekApiKey = "private-key"; c.messages[0].apiKey = "also-private";
  const source = JSON.stringify(C.makeBackup([c]));
  assert(!source.includes("private-key")); assert(!source.includes("also-private"));
  const [restored] = C.parseBackup(source);
  assert.deepEqual(restored.draftImages, [image]); assert.equal(restored.mode, "concise");
  assert.equal(restored.editDraft.text, "corrected"); assert.deepEqual(restored.messages[0].images, [image]);
  assert.equal(c.messages[1].status, "done");
});
test("restore skips duplicates despite later save timestamp; conflicting records become idempotent copies", () => {
  const c = C.normalizeConversation(fixture()); const local = C.copy(c); local.updatedAt += 100;
  assert.equal(C.planRestore([c], [local]).duplicateCount, 1);
  local.messages[0].content = "locally edited";
  const plan = C.planRestore([c], [local]);
  assert.equal(plan.conflictCount, 1); assert.notEqual(plan.additions[0].id, c.id);
  assert.equal(local.messages[0].content, "locally edited");
  assert.equal(C.planRestore([c], [local, ...plan.additions]).duplicateCount, 1);
});
test("bad backups reject unsupported image URLs, malformed records, duplicate ids and unsupported schema", () => {
  const c = fixture();
  assert.throws(() => C.parseBackup("not json"));
  assert.throws(() => C.parseBackup(JSON.stringify({ ...C.makeBackup([c]), version: 99 })));
  assert.throws(() => C.parseBackup(JSON.stringify(C.makeBackup([c, c]))));
  c.draftImages = ["https://example.org/image.png"];
  assert.throws(() => C.parseBackup(JSON.stringify(C.makeBackup([c]))));
  const bad = fixture(); bad.messages[0].images = ["data:image/svg+xml;base64,PHN2Zz4="];
  assert.throws(() => C.parseBackup(JSON.stringify(C.makeBackup([bad]))));
  const wrong = fixture(); wrong.messages[0].role = "system";
  assert.throws(() => C.normalizeConversation(wrong, true));
});
test("editing and regenerating branch from the selected turn without changing original or retaining stale later answers", () => {
  const c = fixture(); c.messages[1].status = "done";
  c.messages.push({ id: "later", role: "user", content: "followup", status: "done", createdAt: 3, images: [] });
  const before = JSON.stringify(c);
  const edit = C.branchConversation(c, "user", "edit", { text: "new", images: [image] });
  assert.equal(edit.messages.length, 0); assert.equal(edit.draftText, "new");
  const redo = C.branchConversation(c, "answer", "retry", {});
  assert.deepEqual(redo.messages.map(m => m.id), ["user"]);
  assert.equal(JSON.stringify(c), before); assert.notEqual(redo.id, c.id);
});
test("long text-only followups retain original screenshot and newest image order, excluding failed assistant context", () => {
  const messages = [{ id: "origin", role: "user", content: "original", images: [image] }];
  for (let i = 0; i < 40; i++) messages.push({ id: String(i), role: i % 2 ? "user" : "assistant", content: String(i), status: "done", images: [] });
  messages.push({ id: "failed", role: "assistant", content: "FAILED", status: "error" });
  const context = C.buildMessages(messages, "steps");
  assert(context.some(m => Array.isArray(m.content) && m.content.some(p => p.type === "image_url")));
  assert(!context.some(m => m.content === "FAILED"));
  const newer = ["1", "2", "3", "4"].map(x => image + x);
  const latest = C.buildMessages([...messages, { id: "new", role: "user", content: "latest", images: newer }]);
  assert.deepEqual(latest.at(-1).content.filter(p => p.type === "image_url").map(p => p.image_url.url), newer);
  assert.equal(latest.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === "image_url").length, 4);
});
