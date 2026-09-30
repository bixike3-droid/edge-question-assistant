"use strict";

// The only HTML inserted into a message comes from markdown-it (raw HTML off)
// and KaTeX (untrusted commands off). Both libraries are bundled locally.
(() => {
  if (typeof globalThis.markdownit !== "function" || typeof globalThis.katex?.renderToString !== "function") return;

  const markdown = globalThis.markdownit({ html: false, breaks: true, linkify: true, typographer: false });
  // Avoid loading third-party images embedded in model-generated Markdown.
  markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content || "");
  const delimiters = [
    { open: "\\[", close: "\\]", display: true },
    { open: "\\(", close: "\\)", display: false },
    { open: "$$", close: "$$", display: true },
    { open: "$", close: "$", display: false }
  ];

  function isEscaped(source, position) {
    let slashes = 0;
    for (let i = position - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
    return slashes % 2 === 1;
  }

  function closingPosition(source, from, delimiter) {
    for (let i = from; i <= source.length - delimiter.close.length; i++) {
      if (!delimiter.display && source[i] === "\n" && source[i + 1] === "\n") return -1;
      if (!source.startsWith(delimiter.close, i) || isEscaped(source, i)) continue;
      if (delimiter.open === "$" && /\s/.test(source[i - 1])) continue;
      return i;
    }
    return -1;
  }

  function extractMath(source) {
    const formulas = [];
    const nonce = crypto.randomUUID().replaceAll("-", "");
    let result = "";
    let i = 0;
    let lineStart = true;
    let fence = null;
    let codeTicks = 0;

    while (i < source.length) {
      if (lineStart) {
        const lineEnd = source.indexOf("\n", i);
        const end = lineEnd < 0 ? source.length : lineEnd;
        const marker = /^ {0,3}(`{3,}|~{3,})/.exec(source.slice(i, end));
        if (fence || marker) {
          if (fence) {
            if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
          } else fence = { char: marker[1][0], length: marker[1].length };
          const next = end + (lineEnd < 0 ? 0 : 1);
          result += source.slice(i, next);
          i = next;
          lineStart = true;
          continue;
        }
      }

      const char = source[i];
      if (char === "\n") { result += char; i++; lineStart = true; continue; }
      lineStart = false;
      if (char === "`") {
        let count = 1;
        while (source[i + count] === "`") count++;
        if (!codeTicks) codeTicks = count;
        else if (count === codeTicks) codeTicks = 0;
        result += source.slice(i, i + count);
        i += count;
        continue;
      }
      if (codeTicks) { result += char; i++; continue; }

      const delimiter = delimiters.find((item) => source.startsWith(item.open, i) && !isEscaped(source, i));
      if (delimiter && !(delimiter.open === "$" && /\s/.test(source[i + 1] || ""))) {
        const start = i + delimiter.open.length;
        const end = closingPosition(source, start, delimiter);
        if (end > start) {
          const formula = source.slice(start, end).trim();
          if (formula) {
            const token = `KATEXPLACEHOLDER${nonce}N${formulas.length}END`;
            let html;
            try {
              html = globalThis.katex.renderToString(formula, {
                displayMode: delimiter.display,
                throwOnError: false,
                trust: false,
                strict: "ignore"
              });
            } catch {
              html = markdown.utils.escapeHtml(source.slice(i, end + delimiter.close.length));
            }
            formulas.push({ token, html, raw: source.slice(i, end + delimiter.close.length) });
            result += token;
            i = end + delimiter.close.length;
            lineStart = source[i - 1] === "\n";
            continue;
          }
        }
      }
      result += char;
      i++;
    }
    return { text: result, formulas };
  }

  function render(source) {
    const { text, formulas } = extractMath(String(source || ""));
    const tokens = markdown.parse(text, {});
    const restoreRaw = (value) => { for (const formula of formulas) value = value.replaceAll(formula.token, formula.raw); return value; };
    const walk = (items) => {
      for (const token of items) {
        if (token.attrs) token.attrs = token.attrs.map(([key, value]) => [key, restoreRaw(value)]);
        if (!token.children) { token.content = restoreRaw(token.content); continue; }
        const children = [];
        for (const child of token.children) {
          if (child.attrs) child.attrs = child.attrs.map(([key, value]) => [key, restoreRaw(value)]);
          if (child.type !== "text") { child.content = restoreRaw(child.content); children.push(child); continue; }
          let content = child.content;
          while (content) {
            let next = null, position = content.length;
            for (const formula of formulas) { const index = content.indexOf(formula.token); if (index >= 0 && index < position) { next = formula; position = index; } }
            if (!next) { const part = new child.constructor("text", "", 0); part.content = content; children.push(part); break; }
            if (position) { const part = new child.constructor("text", "", 0); part.content = content.slice(0, position); children.push(part); }
            const math = new child.constructor("question_math", "", 0); math.content = next.html; children.push(math);
            content = content.slice(position + next.token.length);
          }
        }
        token.children = children;
      }
    };
    walk(tokens);
    return markdown.renderer.render(tokens, markdown.options, {});
  }

  markdown.renderer.rules.question_math = (tokens, index) => tokens[index].content;

  globalThis.answerRenderer = { render };
})();
