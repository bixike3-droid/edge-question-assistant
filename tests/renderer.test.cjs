const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"),path=require("node:path");
globalThis.crypto ||= require("node:crypto").webcrypto;
globalThis.markdownit=require("../vendor/markdown-it/markdown-it.umd.min.js");globalThis.katex=require("../vendor/katex/katex.min.js");require("../renderer.js");
const render=globalThis.answerRenderer.render;
test("four math delimiters, common operations, Markdown and code remain readable",()=>{
  for(const value of ["$x^2$","$$\\frac{1}{2}$$","\\(C_2:x^2=2p_2y\\)","\\[\\boxed{\\sqrt{2}}\\]"])assert(render(value).includes('class="katex"'));
  assert(render("**结论**").includes("<strong>结论</strong>"));
  const tick=String.fromCharCode(96);
  assert(!render(tick+"$x^2$"+tick).includes('class="katex"'));
  assert(!render("    $x^2$\n").includes('class="katex"'));
  assert(!render(tick.repeat(3)+"tex\n\\(x^2\\)\n"+tick.repeat(3)).includes('class="katex"'));
});
test("untrusted HTML, JavaScript URLs and remote images are not executable or fetched",()=>{
  assert(!render('<script>alert(1)</script><img src=x onerror="bad()">').includes("<script>"));
  assert(!render("[x](javascript:alert(1))").includes('href="javascript:'));
  assert(!render("![x](https://example.org/pixel)").includes("<img"));
  const html=render("[formula](https://example.org/$x^2$)");
  for(const match of html.matchAll(/href="([^"]*)"/g)) assert(!match[1].includes("<span"));
  assert(!/style="[^"]*background:url/.test(render("$\\htmlStyle{background:url(javascript:bad)}{x}$")));
});
test("bundled resources and all referenced fonts are present offline",()=>{
  const root=path.resolve(__dirname,".."),html=fs.readFileSync(path.join(root,"sidepanel.html"),"utf8");
  for(const [,src]of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)){assert(!src.startsWith("http"));assert(fs.existsSync(path.join(root,src)),src)}
  const css=fs.readFileSync(path.join(root,"vendor/katex/katex.min.css"),"utf8");
  for(const [,src]of css.matchAll(/url\((fonts\/[^)]+)\)/g))assert(fs.existsSync(path.join(root,"vendor/katex",src)),src);
});
