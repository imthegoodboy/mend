// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as [old, new], for the `R` lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- Files as lines (SPEC.md section 3) ----

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The text of a file an edit creates: LF breaks, a line break after the last line unless `bare`. */
function createdText(lines: string[], bare = false): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (bare ? '' : '\n');
}

// ---- Matching lines at three tiers (SPEC.md section 5) ----

const TIERS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

interface Found {
  tier: number;
  positions: number[];
}

/** Occurrences of `old` in `lines` at the first tier that has one (only tier 0 when strict), keeping those `keep` accepts. */
function locate(lines: string[], old: string[], strict: boolean, keep: (pos: number) => boolean = () => true): Found | null {
  const last = strict ? 0 : 2;
  for (let tier = 0; tier <= last; tier++) {
    const f = TIERS[tier]!;
    const hay = lines.map(f);
    const need = old.map(f);
    const positions: number[] = [];
    for (let i = 0; i + need.length <= hay.length; i++) {
      let all = true;
      for (let j = 0; j < need.length; j++) {
        if (hay[i + j] !== need[j]) {
          all = false;
          break;
        }
      }
      if (all && keep(i)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A line of a hunk, chunk or block body: ' ' context, '-' old, '+' new, '\\' a no-newline note. */
interface Row {
  kind: string;
  text: string;
  bare?: boolean; // the patch line was empty, with no prefix character
}

/** Empty lines at the end of a body are not part of it. */
function dropBare(rows: Row[]): void {
  while (rows.length > 0 && rows[rows.length - 1]!.bare === true) rows.pop();
}

const oldOf = (rows: Row[]): string[] => rows.filter((r) => r.kind === ' ' || r.kind === '-').map((r) => r.text);
const leading = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The lines that replace the matched ones: context as the file has it, and at tier 2 the new lines re-indented. */
function newLines(rows: Row[], file: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const old = oldOf(rows);
  const fileIndent = leading(file[pos] ?? '');
  const patchIndent = leading(old[0] ?? '');
  let j = 0;
  for (const r of rows) {
    if (r.kind === ' ') {
      out.push(file[pos + j]!);
      j += 1;
    } else if (r.kind === '-') j += 1;
    else if (r.kind === '+') {
      const reindent = tier === 2 && !blank(r.text) && r.text.startsWith(patchIndent);
      out.push(reindent ? fileIndent + r.text.slice(patchIndent.length) : r.text);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  start: number; // A of `@@ -A,B +C,D @@`
  rows: Row[];
}

interface Section {
  oldPath: string | null | undefined; // undefined: the patch names none; null: /dev/null
  newPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  creates: boolean;
  deletes: boolean;
  headerOpen: boolean;
  pair: boolean;
  hunks: Hunk[];
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** The path of a `---` or `+++` line: up to the first tab, trimmed; null for /dev/null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  return p === '/dev/null' ? null : stripAB(p);
}

function newSection(): Section {
  return {
    oldPath: undefined,
    newPath: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    gitOld: undefined,
    gitNew: undefined,
    creates: false,
    deletes: false,
    headerOpen: true,
    pair: false,
    hunks: [],
  };
}

/** The two paths of `diff --git a/X b/Y`, or null when the line has no such form. */
function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const same = (rest.length - 5) / 2;
  if (Number.isInteger(same) && same > 0 && rest.slice(2, 2 + same) === rest.slice(5 + same)) {
    if (rest.slice(2 + same, 5 + same) === ' b/') return [rest.slice(2, 2 + same), rest.slice(5 + same)];
  }
  const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return m === null ? null : [m[1]!, m[2]!];
}

function readSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (hunk !== null) {
      const endsHere = l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
      if (!endsHere && (l === '' || ' -+\\'.includes(l[0]!))) {
        hunk.rows.push({ kind: l === '' ? ' ' : l[0]!, text: l.slice(1), bare: l === '' });
        continue;
      }
      dropBare(hunk.rows);
      hunk = null;
    }
    if (l.startsWith('diff --git ')) {
      const p = gitPaths(l);
      if (p === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = p[0];
      cur.gitNew = p[1];
      sections.push(cur);
    } else if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur === null || !cur.headerOpen || cur.pair) {
          cur = newSection();
          sections.push(cur);
        }
        cur.oldPath = headerPath(l);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.pair = true;
        i += 1;
      } else if (cur !== null && cur.headerOpen) throw new Exit2(`error: parse ${i + 2}`);
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.headerOpen = false;
      hunk = { start: Number(m[1]), rows: [] };
      cur.hunks.push(hunk);
    } else if (cur !== null && cur.headerOpen) {
      if (l.startsWith('new file mode')) cur.creates = true;
      else if (l.startsWith('deleted file mode')) cur.deletes = true;
      else if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).replace(/^ +| +$/g, '');
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).replace(/^ +| +$/g, '');
    }
  }
  if (hunk !== null) dropBare(hunk.rows);
  return sections;
}

/** Applies a section's hunks to a file's lines (SPEC.md section 6, "Applying hunks"). */
function applyHunks(file: FileText, hunks: Hunk[], strict: boolean, path: string): void {
  let shift = 0;
  for (const h of hunks) {
    const old = oldOf(h.rows);
    const body = h.rows.filter((r) => r.kind !== '\\');
    let pos: number;
    let tier = 0;
    if (old.length > 0) {
      const found = locate(file.lines, old, strict);
      if (found === null) throw new Fail('no-match', path);
      const want = h.start - 1 + shift;
      pos = found.positions[0]!;
      for (const p of found.positions) if (Math.abs(p - want) < Math.abs(pos - want)) pos = p;
      tier = found.tier;
    } else pos = Math.max(0, Math.min(h.start + shift, file.lines.length));
    const added = newLines(body, file.lines, pos, tier);
    const atEnd = pos + old.length >= file.lines.length;
    file.lines.splice(pos, old.length, ...added);
    shift += added.length - old.length;
    if (atEnd) {
      let lastIdx = -1;
      h.rows.forEach((r, k) => {
        if (r.kind === ' ' || r.kind === '+') lastIdx = k;
      });
      file.final = !(lastIdx >= 0 && h.rows[lastIdx + 1]?.kind === '\\');
    }
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPath !== undefined ? s.oldPath : (s.renameFrom ?? s.gitOld ?? null);
  const newP = s.newPath !== undefined ? s.newPath : (s.renameTo ?? s.gitNew ?? null);
  const creates = s.creates || (s.oldPath === null && s.newPath !== null);
  const deletes = !creates && (s.deletes || (s.newPath === null && s.oldPath !== null));
  return (tree) => {
    const named = creates ? [newP ?? oldP] : deletes ? [oldP ?? newP] : [oldP, newP];
    for (const p of named) if (p !== null && p !== undefined && !safe(p)) throw new Fail('unsafe', p);
    if (creates) {
      const p = (newP ?? oldP)!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let bare = false;
      for (const h of s.hunks) {
        h.rows.forEach((r, k) => {
          if (r.kind === '+') {
            plus.push(r.text);
            bare = h.rows[k + 1]?.kind === '\\';
          }
        });
      }
      tree.now.set(p, createdText(plus, bare));
      return;
    }
    if (deletes) {
      const p = (oldP ?? newP)!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = (oldP ?? newP)!;
    const to = newP ?? from;
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    const moves = to !== from;
    if (moves && tree.get(to) !== null) throw new Fail('exists', to);
    const file = splitFile(before);
    applyHunks(file, s.hunks, strict, from);
    const text = joinFile(file);
    if (moves) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
    tree.now.set(to, text);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return readSections(lines).map((s) => unifiedEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sep = lines.findIndex((l, k) => k > i && l.trimEnd() === '=======');
    const end = sep < 0 ? -1 : lines.findIndex((l, k) => k > sep && l.trimEnd() === '>>>>>>> REPLACE');
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let q = i - 1; q > previousEnd; q--) {
      const t = lines[q]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    path ??= previousPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(blockEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    previousPath = path;
    previousEnd = end;
    i = end + 1;
  }
  return edits;
}

function blockEdit(path: string, old: string[], replacement: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, createdText(replacement));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const found = locate(file.lines, old, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const rows: Row[] = [...old.map((text) => ({ kind: '-', text })), ...replacement.map((text) => ({ kind: '+', text }))];
    file.lines.splice(pos, old.length, ...newLines(rows, file.lines, pos, found.tier));
    tree.now.set(path, joinFile(file));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface Chunk {
  anchor: string | null;
  rows: Row[];
  eof: boolean;
  closed: boolean;
}

const V4A_SECTIONS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last > 0 && blank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const head = lines[i]!;
    if (blank(head)) {
      i += 1;
      continue;
    }
    const kind = V4A_SECTIONS.find((s) => head.startsWith(s));
    if (kind === undefined) throw new Exit2(`error: parse ${i + 1}`);
    const path = head.slice(kind.length).replace(/^ +| +$/g, '');
    let stop = i + 1;
    while (stop < last && !V4A_SECTIONS.some((s) => lines[stop]!.startsWith(s))) stop += 1;
    let bodyEnd = stop;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    const body = lines.slice(i + 1, bodyEnd);
    const at = (k: number): number => i + 1 + k + 1; // the 1-based number of body line k
    if (kind === V4A_SECTIONS[0]) {
      const added = body.map((l, k) => {
        if (l === '') return '';
        if (l.startsWith('+')) return l.slice(1);
        throw new Exit2(`error: parse ${at(k)}`);
      });
      edits.push(addFile(path, added));
    } else if (kind === V4A_SECTIONS[1]) {
      if (body.length > 0) throw new Exit2(`error: parse ${at(0)}`);
      edits.push(deleteFile(path));
    } else {
      let moveTo: string | null = null;
      let from = 0;
      if (body[0]?.startsWith('*** Move to: ') === true) {
        moveTo = body[0].slice('*** Move to: '.length).replace(/^ +| +$/g, '');
        from = 1;
      }
      const chunks: Chunk[] = [];
      let chunk: Chunk | null = null;
      for (let k = from; k < body.length; k++) {
        const l = body[k]!;
        if (l.startsWith('@@')) {
          chunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), rows: [], eof: false, closed: false };
          chunks.push(chunk);
        } else if (l.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, rows: [], eof: false, closed: false };
            chunks.push(chunk);
          }
          chunk.eof = true;
          chunk.closed = true;
        } else if (l === '' || ' -+'.includes(l[0]!)) {
          if (chunk === null && chunks.length === 0) {
            chunk = { anchor: null, rows: [], eof: false, closed: false };
            chunks.push(chunk);
          }
          if (chunk === null || chunk.closed) throw new Exit2(`error: parse ${at(k)}`);
          chunk.rows.push({ kind: l === '' ? ' ' : l[0]!, text: l.slice(1) });
        } else throw new Exit2(`error: parse ${at(k)}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(updateFile(path, moveTo, chunks, strict));
    }
    i = stop;
  }
  return edits;
}

function addFile(path: string, added: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, createdText(added));
  };
}

function deleteFile(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function updateFile(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const file = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const hit = locate(file.lines, [ch.anchor], strict, (p) => p >= cursor);
        if (hit === null) throw new Fail('no-match', path);
        cursor = hit.positions[0]! + 1;
      }
      const old = oldOf(ch.rows);
      let pos = Math.min(cursor, file.lines.length);
      let tier = 0;
      if (old.length > 0) {
        const hit = locate(file.lines, old, strict, (p) => p >= cursor && (!ch.eof || p + old.length === file.lines.length));
        if (hit === null) throw new Fail('no-match', path);
        pos = hit.positions[0]!;
        tier = hit.tier;
      } else if (ch.eof) pos = file.lines.length;
      const added = newLines(ch.rows, file.lines, pos, tier);
      file.lines.splice(pos, old.length, ...added);
      cursor = pos + added.length;
    }
    const text = joinFile(file);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
      tree.now.set(moveTo, text);
    } else tree.now.set(path, text);
  };
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moved = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moved;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that left its old path empty and its new path filled is one `R` line in place of a `D` and an `A`.
  const renamed = new Map<string, string>(); // new path -> old path
  const absorbed = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      renamed.set(to, from);
      absorbed.add(from);
    }
  }
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const listed = changed.filter((p) => !absorbed.has(p)).sort(byBytes);
  const rows = listed.map((p) => {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (renamed.has(p)) return `R ${renamed.get(p)} -> ${p}`;
    return `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`;
  });
  if (!check) {
    for (const p of changed) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.now.get(p);
      if (now === null || now === undefined) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
