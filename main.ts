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
const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');
const stripRightWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadingWs = (s: string): string => s.match(/^[ \t]*/)![0];

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

interface FileLines {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const finalBreak = text !== '' && text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (finalBreak ? br : '');
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly movedFrom = new Map<string, string>();
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
  create(p: string, text: string): void {
    this.now.set(p, text);
    this.movedFrom.delete(p);
  }
  modify(p: string, text: string): void {
    this.now.set(p, text);
  }
  remove(p: string): void {
    this.now.set(p, null);
    this.movedFrom.delete(p);
  }
  move(oldPath: string, newPath: string, text: string): void {
    this.now.set(oldPath, null);
    this.now.set(newPath, text);
    this.movedFrom.delete(oldPath);
    this.movedFrom.set(newPath, oldPath);
  }
}

type Edit = (tree: Tree) => void;

/** Section 5: find all occurrences of `oldLines` in `fileLines` at the first matching tier. */
function findOccurrences(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  minIndex = 0,
  endAtEof = false,
): { tier: number; positions: number[] } | null {
  const k = oldLines.length;
  if (k === 0 || k > fileLines.length) return null;
  const maxTier = strict ? 0 : 2;
  const norm = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? stripRightWs(s) : stripBothWs(s));

  for (let tier = 0; tier <= maxTier; tier += 1) {
    const target = oldLines.map((l) => norm(l, tier));
    const positions: number[] = [];
    const start = endAtEof ? fileLines.length - k : minIndex;
    const end = endAtEof ? fileLines.length - k : fileLines.length - k;
    if (start >= minIndex && start <= end) {
      for (let i = start; i <= end; i += 1) {
        let ok = true;
        for (let j = 0; j < k; j += 1) {
          if (norm(fileLines[i + j]!, tier) !== target[j]) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(i);
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function reindentLine(line: string, fileLead: string, oldLead: string): string {
  if (!blank(line) && line.startsWith(oldLead)) {
    return fileLead + line.slice(oldLead.length);
  }
  return line;
}

type BodyItem =
  | { kind: 'ctx'; text: string; rawEmpty?: boolean }
  | { kind: 'del'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'no-nl' };

function buildReplacement(
  items: BodyItem[],
  fileLines: string[],
  pos: number,
  oldFirstLine: string,
  tier: number,
): string[] {
  const fileLead = tier === 2 ? leadingWs(fileLines[pos]!) : '';
  const oldLead = tier === 2 ? leadingWs(oldFirstLine) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]!);
      oIdx += 1;
    } else if (it.kind === 'del') {
      oIdx += 1;
    } else if (it.kind === 'add') {
      out.push(tier === 2 ? reindentLine(it.text, fileLead, oldLead) : it.text);
    }
  }
  return out;
}

function parseDiffGitLine(line: string): [string, string] | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const candidates: Array<[string, string]> = [];
  for (let idx = rest.indexOf(' b/', 2); idx >= 0; idx = rest.indexOf(' b/', idx + 1)) {
    const x = rest.slice(2, idx);
    const y = rest.slice(idx + 3);
    if (x !== '' && y !== '') candidates.push([x, y]);
  }
  if (candidates.length === 0) return null;
  const equal = candidates.find(([x, y]) => x === y);
  return equal ?? candidates[0]!;
}

function parseUnifiedHeaderPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = trimSpaces(s);
  if (s === '/dev/null') return '/dev/null';
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

interface UnifiedHunk {
  oldStart: number;
  items: BodyItem[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UnifiedHunk[];
  hasHeaderPair: boolean;
}

/** Section 6: parse and build edits for unified diffs. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  const isMinusPlus = (idx: number): boolean =>
    idx + 1 < lines.length && lines[idx]!.startsWith('--- ') && lines[idx + 1]!.startsWith('+++ ');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const pair = parseDiffGitLine(line);
      if (pair === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        gitOld: pair[0],
        gitNew: pair[1],
        minusPath: null,
        plusPath: null,
        renameFrom: null,
        renameTo: null,
        newFileMode: false,
        deletedFileMode: false,
        hunks: [],
        hasHeaderPair: false,
      };
      sections.push(cur);
      i += 1;
      continue;
    }

    if (line.startsWith('--- ')) {
      const inHeader = cur !== null && cur.hunks.length === 0 && !cur.hasHeaderPair;
      if (inHeader) {
        if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        cur!.minusPath = parseUnifiedHeaderPath(line);
        cur!.plusPath = parseUnifiedHeaderPath(lines[i + 1]!);
        cur!.hasHeaderPair = true;
        i += 2;
        continue;
      }
      if (isMinusPlus(i)) {
        cur = {
          gitOld: null,
          gitNew: null,
          minusPath: parseUnifiedHeaderPath(line),
          plusPath: parseUnifiedHeaderPath(lines[i + 1]!),
          renameFrom: null,
          renameTo: null,
          newFileMode: false,
          deletedFileMode: false,
          hunks: [],
          hasHeaderPair: true,
        };
        sections.push(cur);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const oldStart = Number(m[1]);
      i += 1;
      const items: BodyItem[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || isMinusPlus(i)) break;
        if (bl === '') {
          items.push({ kind: 'ctx', text: '', rawEmpty: true });
        } else if (bl.startsWith(' ')) {
          items.push({ kind: 'ctx', text: bl.slice(1) });
        } else if (bl.startsWith('-')) {
          items.push({ kind: 'del', text: bl.slice(1) });
        } else if (bl.startsWith('+')) {
          items.push({ kind: 'add', text: bl.slice(1) });
        } else if (bl.startsWith('\\')) {
          items.push({ kind: 'no-nl' });
        } else {
          break;
        }
        i += 1;
      }
      while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && (items[items.length - 1] as { rawEmpty?: boolean }).rawEmpty) {
        items.pop();
      }
      cur.hunks.push({ oldStart, items });
      continue;
    }

    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = trimSpaces(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) cur.renameTo = trimSpaces(line.slice('rename to '.length));
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFileMode = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletedFileMode = true;
    }
    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldPath = sec.minusPath ?? sec.renameFrom ?? sec.gitOld ?? '';
    const newPath = sec.plusPath ?? sec.renameTo ?? sec.gitNew ?? '';
    const isCreate = oldPath === '/dev/null' || sec.newFileMode;
    const isDelete = !isCreate && (newPath === '/dev/null' || sec.deletedFileMode);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;

    return (tree: Tree) => {
      if (isCreate) {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const created: string[] = [];
        let noNl = false;
        for (const h of sec.hunks) {
          let prevKind: BodyItem['kind'] | null = null;
          for (const it of h.items) {
            if (it.kind === 'add') {
              created.push(it.text);
              noNl = false;
            } else if (it.kind === 'no-nl' && prevKind === 'add') {
              noNl = true;
            }
            prevKind = it.kind;
          }
        }
        tree.create(newPath, joinFile(created, '\n', !noNl));
        return;
      }

      if (isDelete) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.remove(oldPath);
        return;
      }

      if (isMove) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
      } else {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      }

      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const file = splitFile(before);
      let finalBreak = file.finalBreak;
      const curLines = file.lines;
      let d = 0;

      for (const h of sec.hunks) {
        const oldLines: string[] = [];
        let newCount = 0;
        let lastOutIdx = -1;
        h.items.forEach((it, idx) => {
          if (it.kind === 'ctx') {
            oldLines.push(it.text);
            newCount += 1;
            lastOutIdx = idx;
          } else if (it.kind === 'del') {
            oldLines.push(it.text);
          } else if (it.kind === 'add') {
            newCount += 1;
            lastOutIdx = idx;
          }
        });
        const hunkNoNl = lastOutIdx >= 0 && lastOutIdx + 1 < h.items.length && h.items[lastOutIdx + 1]!.kind === 'no-nl';

        if (oldLines.length === 0) {
          const insertPos = Math.max(0, Math.min(h.oldStart + d, curLines.length));
          const atEnd = insertPos === curLines.length;
          const addLines = h.items.filter((it): it is { kind: 'add'; text: string } => it.kind === 'add').map((it) => it.text);
          if (addLines.length > 0) {
            curLines.splice(insertPos, 0, ...addLines);
            if (atEnd) finalBreak = !hunkNoNl;
            d += addLines.length;
          }
        } else {
          const found = findOccurrences(curLines, oldLines, strict);
          if (found === null) throw new Fail('no-match', oldPath);
          const target = h.oldStart - 1 + d;
          let bestPos = found.positions[0]!;
          let bestDist = Math.abs(bestPos - target);
          for (let j = 1; j < found.positions.length; j += 1) {
            const p = found.positions[j]!;
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              bestDist = dist;
              bestPos = p;
            }
          }
          const atEnd = bestPos + oldLines.length === curLines.length;
          const rep = buildReplacement(h.items, curLines, bestPos, oldLines[0]!, found.tier);
          curLines.splice(bestPos, oldLines.length, ...rep);
          if (atEnd) finalBreak = !hunkNoNl;
          d += newCount - oldLines.length;
        }
      }

      const outText = joinFile(curLines, file.br, finalBreak);
      if (isMove) {
        tree.move(oldPath, newPath, outText);
      } else {
        tree.modify(oldPath, outText);
      }
    };
  });
}

/** Section 7: parse and build edits for SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;

  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let foundPath: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        foundPath = t;
        break;
      }
    }
    const path = foundPath ?? prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    prevPath = path;

    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);

    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    prevEnd = repIdx + 1;
    i = repIdx + 1;

    edits.push((tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.create(path, joinFile(newLines, '\n', true));
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const file = splitFile(before);
      const found = findOccurrences(file.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const rep =
        found.tier === 2
          ? newLines.map((l) => reindentLine(l, leadingWs(file.lines[pos]!), leadingWs(oldLines[0]!)))
          : newLines;
      file.lines.splice(pos, oldLines.length, ...rep);
      tree.modify(path, joinFile(file.lines, file.br, file.finalBreak));
    });
  }

  return edits;
}

interface V4aChunk {
  anchor: string;
  items: BodyItem[];
  eof: boolean;
}

/** Section 8: parse and build edits for V4A patches. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    if (!blank(lines[idx]!)) {
      last = idx;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const isSectionHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    const headerLine = i + 1;
    if (!isSectionHeader(header)) throw new Exit2(`error: parse ${headerLine}`);
    let secEnd = i + 1;
    while (secEnd < last && !isSectionHeader(lines[secEnd]!)) secEnd += 1;

    // Blank lines at the end of a section are not part of it.
    let bodyEnd = secEnd;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;

    if (header.startsWith('*** Add File: ')) {
      const path = trimSpaces(header.slice('*** Add File: '.length));
      const addLines: string[] = [];
      for (let j = i + 1; j < bodyEnd; j += 1) {
        const l = lines[j]!;
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.create(path, joinFile(addLines, '\n', true));
      });
    } else if (header.startsWith('*** Delete File: ')) {
      const path = trimSpaces(header.slice('*** Delete File: '.length));
      for (let j = i + 1; j < bodyEnd; j += 1) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree: Tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.remove(path);
      });
    } else {
      const oldPath = trimSpaces(header.slice('*** Update File: '.length));
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < bodyEnd && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = trimSpaces(lines[j]!.slice('*** Move to: '.length));
        j += 1;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      let canStartImplicit = true;

      for (; j < bodyEnd; j += 1) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          curChunk = { anchor: trimSpaces(l.slice(2)), items: [], eof: false };
          chunks.push(curChunk);
          canStartImplicit = false;
        } else if (l.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${j + 1}`);
          curChunk.eof = true;
          curChunk = null;
          canStartImplicit = false;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (!canStartImplicit) throw new Exit2(`error: parse ${j + 1}`);
            curChunk = { anchor: '', items: [], eof: false };
            chunks.push(curChunk);
            canStartImplicit = false;
          }
          if (l === '') curChunk.items.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) curChunk.items.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) curChunk.items.push({ kind: 'del', text: l.slice(1) });
          else curChunk.items.push({ kind: 'add', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${j + 1}`);
        }
      }

      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);

      edits.push((tree: Tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

        const file = splitFile(before);
        const curLines = file.lines;
        let cursor = 0;

        for (const ch of chunks) {
          if (ch.anchor !== '') {
            const foundAnchor = findOccurrences(curLines, [ch.anchor], strict, cursor, false);
            if (foundAnchor === null) throw new Fail('no-match', oldPath);
            cursor = foundAnchor.positions[0]! + 1;
          }
          const oldLines: string[] = [];
          for (const it of ch.items) {
            if (it.kind === 'ctx' || it.kind === 'del') oldLines.push(it.text);
          }
          if (oldLines.length === 0) {
            const insertPos = ch.eof ? curLines.length : cursor;
            const addLines = ch.items.filter((it): it is { kind: 'add'; text: string } => it.kind === 'add').map((it) => it.text);
            curLines.splice(insertPos, 0, ...addLines);
            cursor = insertPos + addLines.length;
          } else {
            const found = findOccurrences(curLines, oldLines, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', oldPath);
            const pos = found.positions[0]!;
            const rep = buildReplacement(ch.items, curLines, pos, oldLines[0]!, found.tier);
            curLines.splice(pos, oldLines.length, ...rep);
            cursor = pos + rep.length;
          }
        }

        const outText = joinFile(curLines, file.br, file.finalBreak);
        if (moveTo !== null) {
          tree.move(oldPath, moveTo, outText);
        } else {
          tree.modify(oldPath, outText);
        }
      });
    }

    i = secEnd;
  }

  return edits;
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
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = new Map(tree.movedFrom);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.movedFrom.clear();
      for (const [k, v] of beforeMoves) tree.movedFrom.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const renameNewToOld = new Map<string, string>();
  const hiddenDeleted = new Set<string>();
  for (const [newP, oldP] of tree.movedFrom) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      if (!hiddenDeleted.has(oldP) && !renameNewToOld.has(newP)) {
        renameNewToOld.set(newP, oldP);
        hiddenDeleted.add(oldP);
      }
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renameNewToOld.has(p)) {
      rows.push(`R ${renameNewToOld.get(p)!} -> ${p}`);
    } else if (!hiddenDeleted.has(p)) {
      rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    }
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
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
