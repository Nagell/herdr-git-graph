// syntax.js: code as coloured runs, for views that draw their own rows. Herdr's highlighter
// only reaches its Editor, which can't draw a diff or mark a line, so this is a small lexer:
// no grammar, but block comments, template strings and open tags carry from line to line.
// Shared byte for byte between Better Files and Better Changes.

const C_LIKE = { line: "//", block: ["/*", "*/"] };
const HASH = { line: "#" };
const SPECS = {
  js: { ...C_LIKE, template: true },
  ts: { ...C_LIKE, template: true },
  jsx: { ...C_LIKE, template: true, markup: true },
  tsx: { ...C_LIKE, template: true, markup: true },
  vue: { ...C_LIKE, template: true, markup: true, markupComment: true },
  svelte: { ...C_LIKE, template: true, markup: true, markupComment: true },
  astro: { ...C_LIKE, template: true, markup: true, markupComment: true },
  html: { markup: true, markupComment: true },
  xml: { markup: true, markupComment: true },
  css: { block: ["/*", "*/"], keys: true },
  go: { ...C_LIKE, template: true },
  rs: { ...C_LIKE, charQuotes: true },
  py: { ...HASH, triple: true },
  sql: { line: "--", block: ["/*", "*/"], anyCase: true },
  lua: { line: "--" },
  hs: { line: "--" },
  json: { keys: true, data: true },
  jsonc: { ...C_LIKE, keys: true },
  yaml: { ...HASH, keys: true, data: true },
  toml: { ...HASH, keys: true, data: true },
  md: { markdown: true },
  txt: { plain: true },
};
const ALIASES = {
  mjs: "js", cjs: "js", mts: "ts", cts: "ts", htm: "html", svg: "xml", plist: "xml",
  scss: "jsonc", less: "jsonc", yml: "yaml", markdown: "md", log: "txt", csv: "txt",
  rb: "py", sh: "py", bash: "py", zsh: "py", fish: "py", nix: "py", r: "py", pl: "py",
  ex: "py", exs: "py", tf: "py", conf: "py", ini: "toml", env: "py", dockerfile: "py",
  makefile: "py", mk: "py", gitignore: "py", elm: "hs",
};
const SPECIAL_NAMES = { Dockerfile: "dockerfile", Makefile: "makefile", Justfile: "makefile" };

const KEYWORDS = new Set(
  ("abstract and as async await begin break case catch class const continue debugger declare def default defer del " +
    "delete do done elif else elsif end ensure enum esac except export extends fi finally fn for from func function " +
    "go if impl implements import in instanceof interface is keyof lambda let local loop match mod module mut " +
    "namespace new not of or override package pass private protected pub public raise readonly require rescue " +
    "return satisfies self static struct super switch then this throw trait try type typeof unless until use var " +
    "void when where while with yield").split(" "),
);
const SQL_KEYWORDS = new Set(
  ("add alter and as asc begin between by case commit create cross delete desc distinct drop else end exists from " +
    "full group having if in index inner insert into is join key left like limit not null offset on or order outer " +
    "primary references returning right rollback select set table then union unique update values view when where with").split(" "),
);
const CONSTANTS = new Set("true false null undefined nil None True False NaN Infinity iota".split(" "));
const TYPES = new Set(
  ("any bigint bool boolean byte char double error f32 f64 float float64 i8 i16 i32 i64 int int32 int64 isize " +
    "never number object rune str string symbol u8 u16 u32 u64 uint unknown usize").split(" "),
);
const HIGHLIGHT_CHARS = 2000;

const NUMBER = /0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_$][\w$]*/y;
const ATTRIBUTE = /[@:#.]?[A-Za-z_][\w.:-]*(?=\s*=|\s|\/?>|$)/y;
const TAG = /<\/?[A-Za-z][\w.:-]*/y;
const DECORATOR = /@[A-Za-z_][\w.]*/y;
const DEFINES = new Set(["def", "fn", "func", "function"]);
const KEY_LINE = /^(\s*(?:-\s+)?)(["']?[\w.@/-]+["']?)(?=\s*[:=](?:\s|$))/;

// The kind of language a path is written in, by extension or by a well-known name.
export function languageOf(path) {
  const name = String(path ?? "").split("/").pop();
  if (SPECIAL_NAMES[name]) return SPECIAL_NAMES[name];
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
}

// The colour of each kind of run, from the theme, close to One Dark's choices.
export function syntaxColors(t) {
  return {
    keyword: t.ansi5,
    string: t.ansi2,
    comment: t.dim,
    number: t.ansi1,
    constant: t.ansi6,
    function: t.ansi4,
    type: t.ansi3,
    tag: t.ansi1,
    attribute: t.ansi3,
    property: t.ansi1,
  };
}

const specFor = (language) => SPECS[ALIASES[language] ?? language] ?? C_LIKE;
const closes = (line, at, quote) => {
  for (let i = at; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
};

// Every line of a file as runs, carrying state from one line to the next.
export function highlightLines(lines, language) {
  let state = null;
  return lines.map((line) => {
    const result = tokenizeLine(line, language, state);
    state = result.state;
    return result.runs;
  });
}

// One line as `{ runs, state }`. `state` is what the line leaves open (a block comment, a
// template string, a tag); pass it with the next line, or null to start fresh.
export function tokenizeLine(line, language, state = null) {
  const spec = specFor(language);
  if (spec.plain || line.length > HIGHLIGHT_CHARS) return { runs: [{ text: line, kind: null }], state: null };
  if (spec.markdown) return { runs: markdownRuns(line), state: null };
  const lexer = new Lexer(line, spec, state);
  lexer.run();
  return { runs: lexer.runs.length ? lexer.runs : [{ text: "", kind: null }], state: lexer.state() };
}

function markdownRuns(line) {
  if (/^#{1,6}\s/.test(line)) return [{ text: line, kind: "keyword" }];
  const runs = [];
  let at = 0;
  for (const match of line.matchAll(/`[^`]+`/g)) {
    if (match.index > at) runs.push({ text: line.slice(at, match.index), kind: null });
    runs.push({ text: match[0], kind: "string" });
    at = match.index + match[0].length;
  }
  if (at < line.length || !runs.length) runs.push({ text: line.slice(at), kind: null });
  return runs;
}

class Lexer {
  constructor(line, spec, state) {
    this.line = line;
    this.spec = spec;
    this.open = state?.open ?? null;
    this.inTag = state?.inTag ?? false;
    this.at = 0;
    this.plainFrom = 0;
    this.runs = [];
  }

  state() {
    return this.open || this.inTag ? { open: this.open, inTag: this.inTag } : null;
  }

  emit(end, kind) {
    if (this.at > this.plainFrom) this.runs.push({ text: this.line.slice(this.plainFrom, this.at), kind: null });
    this.runs.push({ text: this.line.slice(this.at, end), kind });
    this.at = end;
    this.plainFrom = end;
  }

  flushPlain() {
    if (this.line.length > this.plainFrom)
      this.runs.push({ text: this.line.slice(this.plainFrom), kind: null });
  }

  sticky(pattern) {
    pattern.lastIndex = this.at;
    return pattern.exec(this.line)?.[0] ?? null;
  }

  // Finishes whatever an earlier line left open; false while it's still open at the end.
  continueOpen() {
    const { kind, until } = this.open;
    const end = kind === "comment" ? this.line.indexOf(until, this.at) : closes(this.line, this.at, until);
    if (end < 0) {
      this.emit(this.line.length, kind);
      return false;
    }
    this.emit(kind === "comment" ? end + until.length : end, kind);
    this.open = null;
    return true;
  }

  run() {
    if (this.open && !this.continueOpen()) return;
    if (this.spec.keys) this.keyAtStart();
    while (this.at < this.line.length) {
      if (this.inTag ? this.insideTag() : this.next()) continue;
      this.at++;
    }
    this.flushPlain();
  }

  // `key:` in YAML, `key =` in TOML, a JSON key on its own line.
  keyAtStart() {
    const match = KEY_LINE.exec(this.line);
    if (!match) return;
    this.at = match[1].length;
    this.emit(this.at + match[2].length, "property");
  }

  insideTag() {
    const { line, at } = this;
    if (line[at] === ">") {
      this.inTag = false;
      return false;
    }
    if (line.startsWith("/>", at)) {
      this.inTag = false;
      this.at += 2;
      return true;
    }
    const attribute = this.sticky(ATTRIBUTE);
    if (attribute) {
      this.emit(at + attribute.length, "attribute");
      return true;
    }
    return this.next();
  }

  // One token at the cursor; false when the character there stays plain.
  next() {
    const { line, at, spec } = this;
    const char = line[at];
    if (spec.line && line.startsWith(spec.line, at) && !(spec.line === "//" && line[at - 1] === ":")) {
      this.emit(line.length, "comment");
      return true;
    }
    const comment = spec.block && line.startsWith(spec.block[0], at) ? spec.block
      : spec.markupComment && line.startsWith("<!--", at) ? ["<!--", "-->"] : null;
    if (comment) {
      const end = line.indexOf(comment[1], at + comment[0].length);
      if (end < 0) {
        this.open = { kind: "comment", until: comment[1] };
        this.emit(line.length, "comment");
      } else this.emit(end + comment[1].length, "comment");
      return true;
    }
    if (spec.triple && (line.startsWith('"""', at) || line.startsWith("'''", at))) return this.multiline(line.slice(at, at + 3));
    if (char === '"' || (char === "'" && !spec.charQuotes)) return this.quoted(char);
    if (char === "'" && spec.charQuotes) {
      const literal = /'(?:\\.|[^\\'])'/y;
      literal.lastIndex = at;
      if (literal.test(line)) {
        this.emit(literal.lastIndex, "string");
        return true;
      }
      return false;
    }
    if (char === "`") return spec.template ? this.multiline("`") : this.quoted("`");
    if (/\d/.test(char) && !/[\w$]/.test(line[at - 1] ?? "")) {
      const number = this.sticky(NUMBER);
      this.emit(at + number.length, "number");
      return true;
    }
    if (spec.markup && char === "<" && !/[\w$)\]]/.test(line[at - 1] ?? "")) {
      const tag = this.sticky(TAG);
      if (tag) {
        this.emit(at + tag.length, "tag");
        this.inTag = true;
        return true;
      }
    }
    if (char === "@" && !this.inTag) {
      const decorator = this.sticky(DECORATOR);
      if (decorator) {
        this.emit(at + decorator.length, "function");
        return true;
      }
    }
    const word = /[A-Za-z_$]/.test(char) && !/[\w$]/.test(line[at - 1] ?? "") ? this.sticky(WORD) : null;
    if (!word) return false;
    const kind = this.wordKind(word, at);
    this.lastWord = { word, end: at + word.length };
    if (kind) this.emit(at + word.length, kind);
    else this.at += word.length;
    return true;
  }

  // A string that must close on this line; an unclosed quote is an apostrophe, left plain.
  quoted(quote) {
    const end = closes(this.line, this.at + 1, quote);
    if (end < 0) return false;
    const key = this.spec.keys && /^\s*:/.test(this.line.slice(end));
    this.emit(end, key ? "property" : "string");
    return true;
  }

  // A string that may run over lines: a template, a raw Go string, a Python docstring.
  multiline(quote) {
    const end = closes(this.line, this.at + quote.length, quote);
    if (end < 0) {
      this.open = { kind: "string", until: quote };
      this.emit(this.line.length, "string");
    } else this.emit(end, "string");
    return true;
  }

  wordKind(word, at) {
    const { line, spec } = this;
    if (spec.anyCase) return SQL_KEYWORDS.has(word.toLowerCase()) ? "keyword" : null;
    if (spec.data) return CONSTANTS.has(word) ? "constant" : null;
    const named = this.lastWord && DEFINES.has(this.lastWord.word);
    if (named && /^\s+$/.test(line.slice(this.lastWord.end, at))) return "function";
    const after = line.slice(at + word.length);
    const member = line[at - 1] === "." && line[at - 2] !== ".";
    if (!member && KEYWORDS.has(word)) return "keyword";
    if (CONSTANTS.has(word)) return "constant";
    if (/^\s*(?:\?\.)?\(/.test(after)) return member || !/^[A-Z]/.test(word) ? "function" : "type";
    if (TYPES.has(word) || /^[A-Z][A-Za-z\d]*[a-z][A-Za-z\d]*$/.test(word)) return "type";
    if (word.length > 1 && /^[A-Z][A-Z\d_]*$/.test(word)) return "constant";
    return null;
  }
}
