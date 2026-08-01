import { extname } from "node:path";

export const SUPPORTED_SOURCE_EXTENSIONS = [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".py", ".ts", ".tsx"];
const JAVASCRIPT_EXTENSIONS = new Set(SUPPORTED_SOURCE_EXTENSIONS.filter((extension) => extension !== ".py"));

function compareImports(left, right) {
  for (const field of ["specifier", "type", "syntax"]) {
    const order = Buffer.from(left[field]).compare(Buffer.from(right[field]));
    if (order !== 0) return order;
  }
  return 0;
}

export function languageForPath(path) {
  const extension = extname(path).toLowerCase();
  if (JAVASCRIPT_EXTENSIONS.has(extension)) return extension.includes("ts") ? "typescript" : "javascript";
  if (extension === ".py") return "python";
  return null;
}

function readQuoted(source, start, quote) {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === quote) return { value, end: index + 1, closed: true };
    if (char === "\\") {
      const next = source[index + 1];
      if (next === "\n" || next === "\r") {
        index += next === "\r" && source[index + 2] === "\n" ? 2 : 1;
        continue;
      }
      if (next === quote || next === "\\") value += next;
      else value += `\\${next || ""}`;
      index += 1;
      continue;
    }
    value += char;
  }
  return { value, end: source.length, closed: false };
}

function javascriptTokens(source) {
  const tokens = [];
  const skipped = [];
  let index = 0;
  let previous = null;
  const regexPrefix = new Set(["(", "[", "{", ":", ";", ",", "=", "!", "?", "+", "-", "*", "%", "&", "|", "^", "~", "<", ">"]);
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        skipped.push({ reason: "unterminated-comment" });
        break;
      }
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const string = readQuoted(source, index, char);
      tokens.push({ type: "string", value: string.value });
      if (!string.closed) skipped.push({ reason: "unterminated-string" });
      index = string.end;
      previous = tokens.at(-1);
      continue;
    }
    if (char === "`") {
      const template = readQuoted(source, index, "`");
      tokens.push({ type: template.value.includes("${") ? "template-expression" : "string", value: template.value });
      if (!template.closed) skipped.push({ reason: "unterminated-template" });
      index = template.end;
      previous = tokens.at(-1);
      continue;
    }
    if (char === "/" && (!previous || (previous.type === "punct" && regexPrefix.has(previous.value)) || (previous.type === "identifier" && ["case", "delete", "return", "throw", "typeof", "void", "yield"].includes(previous.value)))) {
      let inClass = false;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "[") { inClass = true; index += 1; }
        else if (source[index] === "]") { inClass = false; index += 1; }
        else if (source[index] === "/" && !inClass) {
          index += 1;
          while (/[A-Za-z]/.test(source[index] || "")) index += 1;
          break;
        } else index += 1;
      }
      previous = { type: "regex", value: "" };
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(source[end] || "")) end += 1;
      previous = { type: "identifier", value: source.slice(index, end) };
      tokens.push(previous);
      index = end;
      continue;
    }
    previous = { type: "punct", value: char };
    tokens.push(previous);
    index += 1;
  }
  return { tokens, skipped };
}

function javascriptImports(source) {
  const { tokens, skipped } = javascriptTokens(source);
  const imports = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;
    if (token.value === "require" && tokens[index - 1]?.value !== "." && tokens[index + 1]?.value === "(") {
      if (tokens[index + 2]?.type === "string" && tokens[index + 3]?.value === ")") imports.push({ type: "requires", syntax: "require", specifier: tokens[index + 2].value });
      else skipped.push({ reason: "non-literal-require", syntax: "require" });
      continue;
    }
    if (token.value !== "import" || tokens[index - 1]?.value === ".") continue;
    if (tokens[index + 1]?.value === "(") {
      if (tokens[index + 2]?.type === "string" && tokens[index + 3]?.value === ")") imports.push({ type: "imports", syntax: "dynamic-import", specifier: tokens[index + 2].value });
      else skipped.push({ reason: "non-literal-dynamic-import", syntax: "dynamic-import" });
      continue;
    }
    if (tokens[index + 1]?.type === "string") {
      imports.push({ type: "imports", syntax: "import", specifier: tokens[index + 1].value });
      continue;
    }
    for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 64); cursor += 1) {
      if (tokens[cursor]?.value === ";" || tokens[cursor]?.value === "import") break;
      if (tokens[cursor]?.value === "from" && tokens[cursor + 1]?.type === "string") {
        imports.push({ type: "imports", syntax: "import", specifier: tokens[cursor + 1].value });
        break;
      }
    }
  }
  return { imports: imports.sort(compareImports), skipped };
}

function pythonTokens(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "#") {
      index = source.indexOf("\n", index + 1);
      if (index < 0) break;
      continue;
    }
    if (char === "'" || char === '"') {
      const triple = source.slice(index, index + 3) === char.repeat(3);
      if (triple) {
        const end = source.indexOf(char.repeat(3), index + 3);
        index = end < 0 ? source.length : end + 3;
      } else index = readQuoted(source, index, char).end;
      continue;
    }
    if (char === "\n" || char === ";") {
      tokens.push({ type: "end", value: char });
      index += 1;
      continue;
    }
    if (/\s/.test(char) || (char === "\\" && source[index + 1] === "\n")) {
      index += char === "\\" ? 2 : 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_]/.test(source[end] || "")) end += 1;
      tokens.push({ type: "identifier", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ type: "punct", value: char });
    index += 1;
  }
  return tokens;
}

function pythonImports(source) {
  const tokens = pythonTokens(source);
  const imports = [];
  const dottedName = (start) => {
    let cursor = start;
    let value = "";
    while (tokens[cursor]?.value === ".") {
      value += ".";
      cursor += 1;
    }
    if (tokens[cursor]?.type === "identifier") {
      value += tokens[cursor].value;
      cursor += 1;
      while (tokens[cursor]?.value === "." && tokens[cursor + 1]?.type === "identifier") {
        value += `.${tokens[cursor + 1].value}`;
        cursor += 2;
      }
    }
    return { value, cursor };
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === "from") {
      const name = dottedName(index + 1);
      if (name.value && tokens[name.cursor]?.value === "import") {
        imports.push({ type: "imports", syntax: "python-from", specifier: name.value });
        index = name.cursor;
      }
      continue;
    }
    if (tokens[index].value !== "import" || tokens[index - 1]?.value === "from") continue;
    let cursor = index + 1;
    while (tokens[cursor] && tokens[cursor].type !== "end") {
      const name = dottedName(cursor);
      if (name.value) imports.push({ type: "imports", syntax: "python-import", specifier: name.value });
      cursor = name.cursor;
      while (tokens[cursor] && tokens[cursor].type !== "end" && tokens[cursor].value !== ",") cursor += 1;
      if (tokens[cursor]?.value === ",") cursor += 1;
    }
  }
  return { imports: imports.sort(compareImports), skipped: [] };
}

export function scanSource(path, source) {
  const language = languageForPath(path);
  if (!language) return { status: "skipped", language: null, imports: [], skipped: [{ reason: "unsupported-language" }] };
  const result = language === "python" ? pythonImports(source) : javascriptImports(source);
  return { status: "scanned", language, ...result };
}
