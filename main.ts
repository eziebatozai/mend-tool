// mend: unified patch applier implementing SPEC.md (version 1).
// Supports unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits.
// Node 22 standard library only; deterministic; atomic commit.
//
// In a trial, MAKEFUN_ENV_URL triggers runner.ts (preserved at bottom).

import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Constants & Errors
// ---------------------------------------------------------------------------

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';
type CliFormatOption = 'auto' | FormatName;

const VALID_FORMATS = new Set<string>(['auto', 'unified', 'search-replace', 'v4a', 'json']);

class Exit2Error extends Error {
  readonly messageLine: string;
  constructor(messageLine: string) {
    super(messageLine);
    this.messageLine = messageLine;
  }
}

class EditFailError extends Error {
  readonly code: 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';
  readonly path: string;
  constructor(code: 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe', path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Text, Line, and Path Utilities (Section 3)
// ---------------------------------------------------------------------------

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

function stripOuterSpaces(text: string): string {
  return text.replace(/^ +| +$/g, '');
}

function stripTrailingSpacesTabs(line: string): string {
  return line.replace(/[ \t]+$/, '');
}

function stripOuterSpacesTabs(line: string): string {
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

function getLeadingSpacesTabs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

function splitPatchLines(text: string): string[] {
  if (text.length === 0) return [];
  const raw = text.split('\n');
  if (text.endsWith('\n')) raw.pop();
  return raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

interface FileDoc {
  eol: '\r\n' | '\n';
  lines: string[];
  hasTrailingEol: boolean;
}

function parseFileText(text: string): FileDoc {
  const firstLf = text.indexOf('\n');
  const eol: '\r\n' | '\n' = firstLf > 0 && text.charCodeAt(firstLf - 1) === 13 ? '\r\n' : '\n';
  if (text.length === 0) {
    return { eol, lines: [], hasTrailingEol: false };
  }
  const lines = text.split(eol);
  const hasTrailingEol = text.endsWith(eol);
  if (hasTrailingEol) lines.pop();
  return { eol, lines, hasTrailingEol };
}

function renderFileText(lines: string[], eol: '\r\n' | '\n', hasTrailingEol: boolean): string {
  if (lines.length === 0) return '';
  return hasTrailingEol ? lines.join(eol) + eol : lines.join(eol);
}

function isSafePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')) return false;
  const segments = path.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------
// Virtual Tree with Atomic Rollback & Two-Phase Disk Commit (Sections 2 & 10)
// ---------------------------------------------------------------------------

interface TreeSnapshot {
  overlay: Map<string, string | null>;
  moveSource: Map<string, string>;
}

class VirtualTree {
  private readonly diskCache = new Map<string, string | null>();
  readonly overlay = new Map<string, string | null>();
  readonly moveSource = new Map<string, string>();

  original(path: string): string | null {
    if (!this.diskCache.has(path)) {
      let content: string | null = null;
      try {
        if (statSync(path).isFile()) {
          content = readFileSync(path, 'utf8');
        }
      } catch {
        content = null;
      }
      this.diskCache.set(path, content);
    }
    return this.diskCache.get(path)!;
  }

  read(path: string): string | null {
    return this.overlay.has(path) ? this.overlay.get(path)! : this.original(path);
  }

  writeNew(path: string, text: string): void {
    this.overlay.set(path, text);
    this.moveSource.delete(path);
  }

  writeExisting(path: string, text: string): void {
    this.overlay.set(path, text);
  }

  deleteFile(path: string): void {
    this.overlay.set(path, null);
    this.moveSource.delete(path);
  }

  moveFile(fromPath: string, toPath: string, text: string): void {
    this.overlay.set(fromPath, null);
    this.overlay.set(toPath, text);
    this.moveSource.delete(fromPath);
    this.moveSource.set(toPath, fromPath);
  }

  snapshot(): TreeSnapshot {
    return {
      overlay: new Map(this.overlay),
      moveSource: new Map(this.moveSource),
    };
  }

  restore(snap: TreeSnapshot): void {
    this.overlay.clear();
    for (const [k, v] of snap.overlay) this.overlay.set(k, v);
    this.moveSource.clear();
    for (const [k, v] of snap.moveSource) this.moveSource.set(k, v);
  }

  commit(dryRun: boolean): string[] {
    const renameDestToSrc = new Map<string, string>();
    const suppressedDeletes = new Set<string>();

    for (const [destPath, srcPath] of this.moveSource) {
      const srcExistedBefore = this.original(srcPath) !== null;
      const srcDeletedAfter = this.read(srcPath) === null;
      const destMissingBefore = this.original(destPath) === null;
      const destExistsAfter = this.read(destPath) !== null;
      if (srcExistedBefore && srcDeletedAfter && destMissingBefore && destExistsAfter) {
        if (!suppressedDeletes.has(srcPath) && !renameDestToSrc.has(destPath)) {
          renameDestToSrc.set(destPath, srcPath);
          suppressedDeletes.add(srcPath);
        }
      }
    }

    const touchedPaths = [...this.overlay.keys()].sort(utf8Compare);
    const summaryRows: string[] = [];
    const toDelete: string[] = [];
    const toWrite: Array<[string, string]> = [];

    for (const p of touchedPaths) {
      const before = this.original(p);
      const after = this.overlay.get(p)!;
      if (before === after) continue;

      if (renameDestToSrc.has(p)) {
        summaryRows.push(`R ${renameDestToSrc.get(p)!} -> ${p}`);
      } else if (!suppressedDeletes.has(p)) {
        const tag = before === null ? 'A' : after === null ? 'D' : 'M';
        summaryRows.push(`${tag} ${p}`);
      }

      if (after === null) {
        toDelete.push(p);
      } else {
        toWrite.push([p, after]);
      }
    }

    if (!dryRun) {
      // Phase 1: delete removed files first and prune newly emptied parent directories
      // so replacing a directory tree (e.g. foo/bar) with a file (foo) never fails with EISDIR.
      for (const p of toDelete) {
        rmSync(p, { force: true });
        let parent = dirname(p);
        while (parent !== '.' && parent !== '' && parent !== '/') {
          try {
            rmdirSync(parent);
          } catch {
            break;
          }
          const next = dirname(parent);
          if (next === parent) break;
          parent = next;
        }
      }
      // Phase 2: create directories and write all added/modified files.
      for (const [p, content] of toWrite) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
    }

    const noun = summaryRows.length === 1 ? 'file' : 'files';
    return [...summaryRows, `ok: ${summaryRows.length} ${noun}`];
  }
}

// ---------------------------------------------------------------------------
// Tiered Line Matching & Re-indentation Engine (Section 5)
// ---------------------------------------------------------------------------

interface MatchResult {
  tier: 0 | 1 | 2;
  positions: number[];
}

function locatePattern(
  fileLines: string[],
  pattern: string[],
  strict: boolean,
  minIndex = 0,
  eofOnly = false,
): MatchResult | null {
  const patLen = pattern.length;
  const fileLen = fileLines.length;
  if (patLen === 0 || patLen > fileLen) return null;

  const start = eofOnly ? fileLen - patLen : minIndex;
  const end = fileLen - patLen;
  if (start < minIndex || start > end) return null;

  const maxTier: 0 | 1 | 2 = strict ? 0 : 2;
  for (let tier = 0 as 0 | 1 | 2; tier <= maxTier; tier = (tier + 1) as 0 | 1 | 2) {
    let normFile: string[];
    let normPat: string[];
    if (tier === 0) {
      normFile = fileLines;
      normPat = pattern;
    } else if (tier === 1) {
      normFile = fileLines.map(stripTrailingSpacesTabs);
      normPat = pattern.map(stripTrailingSpacesTabs);
    } else {
      normFile = fileLines.map(stripOuterSpacesTabs);
      normPat = pattern.map(stripOuterSpacesTabs);
    }

    const firstTarget = normPat[0]!;
    const positions: number[] = [];
    for (let i = start; i <= end; i += 1) {
      if (normFile[i] !== firstTarget) continue;
      let matched = true;
      for (let j = 1; j < patLen; j += 1) {
        if (normFile[i + j] !== normPat[j]) {
          matched = false;
          break;
        }
      }
      if (matched) positions.push(i);
    }
    if (positions.length > 0) {
      return { tier, positions };
    }
  }

  return null;
}

function reindentForTier2(line: string, fileLead: string, patchLead: string): string {
  if (!isBlankLine(line) && line.startsWith(patchLead)) {
    return fileLead + line.slice(patchLead.length);
  }
  return line;
}

type DiffItem =
  | { kind: 'ctx'; text: string; emptyLine?: boolean }
  | { kind: 'del'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'no-eol' };

function renderHunkReplacement(
  items: DiffItem[],
  fileLines: string[],
  matchPos: number,
  oldFirstLine: string,
  tier: 0 | 1 | 2,
): string[] {
  const fileLead = tier === 2 ? getLeadingSpacesTabs(fileLines[matchPos]!) : '';
  const patchLead = tier === 2 ? getLeadingSpacesTabs(oldFirstLine) : '';
  const result: string[] = [];
  let oldOffset = 0;

  for (const item of items) {
    if (item.kind === 'ctx') {
      result.push(fileLines[matchPos + oldOffset]!);
      oldOffset += 1;
    } else if (item.kind === 'del') {
      oldOffset += 1;
    } else if (item.kind === 'add') {
      result.push(tier === 2 ? reindentForTier2(item.text, fileLead, patchLead) : item.text);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Intermediate Representation (Parsed Edit Operations)
// ---------------------------------------------------------------------------

interface UnifiedHunkAst {
  oldStart: number;
  items: DiffItem[];
}

interface V4aChunkAst {
  anchor: string;
  items: DiffItem[];
  eof: boolean;
}

type EditOp =
  | { format: 'unified'; kind: 'create'; path: string; hunks: UnifiedHunkAst[] }
  | { format: 'unified'; kind: 'delete'; path: string }
  | { format: 'unified'; kind: 'move'; oldPath: string; newPath: string; hunks: UnifiedHunkAst[] }
  | { format: 'unified'; kind: 'modify'; path: string; hunks: UnifiedHunkAst[] }
  | { format: 'search-replace'; path: string; oldLines: string[]; newLines: string[] }
  | { format: 'v4a'; kind: 'add'; path: string; lines: string[] }
  | { format: 'v4a'; kind: 'delete'; path: string }
  | { format: 'v4a'; kind: 'update'; oldPath: string; moveTo: string | null; chunks: V4aChunkAst[] }
  | { format: 'json'; kind: 'create'; path: string; fileText: string }
  | { format: 'json'; kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { format: 'json'; kind: 'insert'; path: string; insertLine: number; addLines: string[] };

// ---------------------------------------------------------------------------
// Format Detection (Section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): FormatName | null {
  const firstIdx = lines.findIndex((l) => !isBlankLine(l));
  if (firstIdx < 0) return null;
  const firstLine = lines[firstIdx]!;
  if (firstLine.trim() === '*** Begin Patch') return 'v4a';
  const firstChar = firstLine.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parser 1: Unified Diffs (Section 6)
// ---------------------------------------------------------------------------

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_PREFIX_RE = /^diff --git(?:\s|$)/;

function parseDiffGitPaths(line: string): [string, string] | null {
  if (!line.startsWith('diff --git ')) return null;
  const body = line.slice('diff --git '.length);
  if (!body.startsWith('a/')) return null;

  const pairs: Array<[string, string]> = [];
  for (let pos = body.indexOf(' b/', 2); pos >= 0; pos = body.indexOf(' b/', pos + 1)) {
    const oldP = body.slice(2, pos);
    const newP = body.slice(pos + 3);
    if (oldP.length > 0 && newP.length > 0) {
      pairs.push([oldP, newP]);
    }
  }
  if (pairs.length === 0) return null;
  const identical = pairs.find(([a, b]) => a === b);
  return identical ?? pairs[0]!;
}

function extractHeaderPath(line: string): string {
  let raw = line.slice(4);
  const tabIdx = raw.indexOf('\t');
  if (tabIdx >= 0) raw = raw.slice(0, tabIdx);
  raw = stripOuterSpaces(raw);
  if (raw === '/dev/null') return '/dev/null';
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

interface RawUnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNewMode: boolean;
  isDeletedMode: boolean;
  sawMinusPlus: boolean;
  hunks: UnifiedHunkAst[];
}

function parseUnifiedDiff(lines: string[]): EditOp[] {
  const sections: RawUnifiedSection[] = [];
  let current: RawUnifiedSection | null = null;

  const hasMinusPlusAt = (idx: number): boolean =>
    idx + 1 < lines.length && lines[idx]!.startsWith('--- ') && lines[idx + 1]!.startsWith('+++ ');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (DIFF_GIT_PREFIX_RE.test(line)) {
      const parsed = parseDiffGitPaths(line);
      if (parsed === null) throw new Exit2Error(`error: parse ${i + 1}`);
      current = {
        gitOld: parsed[0],
        gitNew: parsed[1],
        minusPath: null,
        plusPath: null,
        renameFrom: null,
        renameTo: null,
        isNewMode: false,
        isDeletedMode: false,
        sawMinusPlus: false,
        hunks: [],
      };
      sections.push(current);
      i += 1;
      continue;
    }

    if (line.startsWith('--- ')) {
      const inHeaderExpectingPair = current !== null && current.hunks.length === 0 && !current.sawMinusPlus;
      if (inHeaderExpectingPair) {
        if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) {
          throw new Exit2Error(`error: parse ${i + 2}`);
        }
        current!.minusPath = extractHeaderPath(line);
        current!.plusPath = extractHeaderPath(lines[i + 1]!);
        current!.sawMinusPlus = true;
        i += 2;
        continue;
      }
      if (hasMinusPlusAt(i)) {
        current = {
          gitOld: null,
          gitNew: null,
          minusPath: extractHeaderPath(line),
          plusPath: extractHeaderPath(lines[i + 1]!),
          renameFrom: null,
          renameTo: null,
          isNewMode: false,
          isDeletedMode: false,
          sawMinusPlus: true,
          hunks: [],
        };
        sections.push(current);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      const m = HUNK_HEADER_RE.exec(line);
      if (m === null || current === null) {
        throw new Exit2Error(`error: parse ${i + 1}`);
      }
      const oldStart = Number(m[1]);
      i += 1;
      const items: DiffItem[] = [];
      while (i < lines.length) {
        const bodyLine = lines[i]!;
        if (bodyLine.startsWith('diff --git ') || hasMinusPlusAt(i)) break;
        if (bodyLine === '') {
          items.push({ kind: 'ctx', text: '', emptyLine: true });
        } else if (bodyLine.startsWith(' ')) {
          items.push({ kind: 'ctx', text: bodyLine.slice(1) });
        } else if (bodyLine.startsWith('-')) {
          items.push({ kind: 'del', text: bodyLine.slice(1) });
        } else if (bodyLine.startsWith('+')) {
          items.push({ kind: 'add', text: bodyLine.slice(1) });
        } else if (bodyLine.startsWith('\\')) {
          items.push({ kind: 'no-eol' });
        } else {
          break;
        }
        i += 1;
      }
      while (items.length > 0) {
        const tail = items[items.length - 1]!;
        if (tail.kind === 'ctx' && tail.emptyLine) items.pop();
        else break;
      }
      current.hunks.push({ oldStart, items });
      continue;
    }

    if (current !== null && current.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        current.renameFrom = stripOuterSpaces(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        current.renameTo = stripOuterSpaces(line.slice('rename to '.length));
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        current.isNewMode = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        current.isDeletedMode = true;
      }
    }

    i += 1;
  }

  return sections.map((sec): EditOp => {
    const oldPath = sec.minusPath ?? sec.renameFrom ?? sec.gitOld ?? '';
    const newPath = sec.plusPath ?? sec.renameTo ?? sec.gitNew ?? '';
    if (oldPath === '/dev/null' || sec.isNewMode) {
      return { format: 'unified', kind: 'create', path: newPath, hunks: sec.hunks };
    }
    if (newPath === '/dev/null' || sec.isDeletedMode) {
      return { format: 'unified', kind: 'delete', path: oldPath };
    }
    if (oldPath !== newPath) {
      return { format: 'unified', kind: 'move', oldPath, newPath, hunks: sec.hunks };
    }
    return { format: 'unified', kind: 'modify', path: oldPath, hunks: sec.hunks };
  });
}

// ---------------------------------------------------------------------------
// Parser 2: SEARCH/REPLACE Blocks (Section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): EditOp[] {
  const ops: EditOp[] = [];
  let scanFloor = 0;
  let lastPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;

    let path: string | null = null;
    for (let j = searchIdx - 1; j >= scanFloor; j -= 1) {
      const trimmed = lines[j]!.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('```')) {
        path = trimmed;
        break;
      }
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2Error(`error: parse ${searchIdx + 1}`);
    lastPath = path;

    let sepIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      const m = lines[j]!.trimEnd();
      if (m === '=======') {
        sepIdx = j;
        break;
      }
      if (m === '>>>>>>> REPLACE' || m === '<<<<<<< SEARCH') {
        throw new Exit2Error(`error: parse ${searchIdx + 1}`);
      }
    }
    if (sepIdx < 0) throw new Exit2Error(`error: parse ${searchIdx + 1}`);

    let endIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j += 1) {
      const m = lines[j]!.trimEnd();
      if (m === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
      if (m === '<<<<<<< SEARCH') {
        throw new Exit2Error(`error: parse ${searchIdx + 1}`);
      }
    }
    if (endIdx < 0) throw new Exit2Error(`error: parse ${searchIdx + 1}`);

    ops.push({
      format: 'search-replace',
      path,
      oldLines: lines.slice(searchIdx + 1, sepIdx),
      newLines: lines.slice(sepIdx + 1, endIdx),
    });

    scanFloor = endIdx + 1;
    i = endIdx + 1;
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Parser 3: V4A Patches (Section 8)
// ---------------------------------------------------------------------------

function isV4aSectionHeader(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function parseV4aPatch(lines: string[]): EditOp[] {
  const firstIdx = lines.findIndex((l) => !isBlankLine(l));
  if (firstIdx < 0) throw new Exit2Error('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') {
    throw new Exit2Error(`error: parse ${firstIdx + 1}`);
  }

  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlankLine(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lastIdx < 0 || lines[lastIdx]!.trim() !== '*** End Patch') {
    throw new Exit2Error(`error: parse ${lines.length + 1}`);
  }

  const ops: EditOp[] = [];
  let i = firstIdx + 1;

  while (i < lastIdx) {
    if (isBlankLine(lines[i]!)) {
      i += 1;
      continue;
    }
    const header = lines[i]!;
    const headerLineNo = i + 1;
    if (!isV4aSectionHeader(header)) {
      throw new Exit2Error(`error: parse ${headerLineNo}`);
    }

    if (header.startsWith('*** Delete File: ')) {
      const path = stripOuterSpaces(header.slice('*** Delete File: '.length));
      ops.push({ format: 'v4a', kind: 'delete', path });
      i += 1;
      continue;
    }

    let secEnd = i + 1;
    while (secEnd < lastIdx && !isV4aSectionHeader(lines[secEnd]!)) {
      secEnd += 1;
    }

    // Blank lines at the end of a section (before the next section or *** End Patch) are not part of it.
    let bodyEnd = secEnd;
    while (bodyEnd > i + 1 && isBlankLine(lines[bodyEnd - 1]!)) {
      bodyEnd -= 1;
    }

    if (header.startsWith('*** Add File: ')) {
      const path = stripOuterSpaces(header.slice('*** Add File: '.length));
      const fileLines: string[] = [];
      for (let j = i + 1; j < bodyEnd; j += 1) {
        const l = lines[j]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2Error(`error: parse ${j + 1}`);
      }
      ops.push({ format: 'v4a', kind: 'add', path, lines: fileLines });
    } else {
      const oldPath = stripOuterSpaces(header.slice('*** Update File: '.length));
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < bodyEnd && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = stripOuterSpaces(lines[j]!.slice('*** Move to: '.length));
        j += 1;
      }

      const chunks: V4aChunkAst[] = [];
      let activeChunk: V4aChunkAst | null = null;
      let allowImplicitFirst = true;

      for (; j < bodyEnd; j += 1) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          activeChunk = { anchor: stripOuterSpaces(l.slice(2)), items: [], eof: false };
          chunks.push(activeChunk);
          allowImplicitFirst = false;
        } else if (l.trimEnd() === '*** End of File') {
          if (activeChunk === null) throw new Exit2Error(`error: parse ${j + 1}`);
          activeChunk.eof = true;
          activeChunk = null;
          allowImplicitFirst = false;
        } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (activeChunk === null) {
            if (!allowImplicitFirst) throw new Exit2Error(`error: parse ${j + 1}`);
            activeChunk = { anchor: '', items: [], eof: false };
            chunks.push(activeChunk);
            allowImplicitFirst = false;
          }
          if (l === '') activeChunk.items.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) activeChunk.items.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) activeChunk.items.push({ kind: 'del', text: l.slice(1) });
          else activeChunk.items.push({ kind: 'add', text: l.slice(1) });
        } else {
          throw new Exit2Error(`error: parse ${j + 1}`);
        }
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2Error(`error: parse ${headerLineNo}`);
      }

      ops.push({ format: 'v4a', kind: 'update', oldPath, moveTo, chunks });
    }

    i = secEnd;
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Parser 4: JSON Edits (Section 9)
// ---------------------------------------------------------------------------

function parseSingleJsonOp(value: unknown): EditOp | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== 'string') return null;

  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    return { format: 'json', kind: 'create', path: obj.path, fileText: obj.file_text };
  }

  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str.length === 0) return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    return {
      format: 'json',
      kind: 'str_replace',
      path: obj.path,
      oldStr: obj.old_str,
      newStr: (obj.new_str as string | undefined) ?? '',
    };
  }

  if (obj.command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    return {
      format: 'json',
      kind: 'insert',
      path: obj.path,
      insertLine: obj.insert_line,
      addLines: splitPatchLines(obj.new_str),
    };
  }

  return null;
}

function parseJsonEdits(text: string, lines: string[]): EditOp[] {
  const firstIdx = lines.findIndex((l) => !isBlankLine(l));
  if (firstIdx < 0) throw new Exit2Error('error: parse 1');

  if (lines[firstIdx]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2Error(`error: parse ${firstIdx + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2Error(`error: parse ${firstIdx + 1}`);
    const ops: EditOp[] = [];
    for (const entry of parsed) {
      const op = parseSingleJsonOp(entry);
      if (op === null) throw new Exit2Error(`error: parse ${firstIdx + 1}`);
      ops.push(op);
    }
    return ops;
  }

  const ops: EditOp[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isBlankLine(line)) continue;
    let op: EditOp | null = null;
    try {
      op = parseSingleJsonOp(JSON.parse(line));
    } catch {
      op = null;
    }
    if (op === null) throw new Exit2Error(`error: parse ${i + 1}`);
    ops.push(op);
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Edit Execution Engine (Sections 5, 6, 7, 8, 9, 10)
// ---------------------------------------------------------------------------

function requireSafe(path: string): void {
  if (!isSafePath(path)) throw new EditFailError('unsafe', path);
}

function requireExisting(tree: VirtualTree, path: string): string {
  const content = tree.read(path);
  if (content === null) throw new EditFailError('missing', path);
  return content;
}

function requireAbsent(tree: VirtualTree, path: string): void {
  if (tree.read(path) !== null) throw new EditFailError('exists', path);
}

function applyUnifiedHunks(
  doc: FileDoc,
  hunks: UnifiedHunkAst[],
  errorPath: string,
  strict: boolean,
): string {
  const lines = [...doc.lines];
  let hasTrailingEol = doc.hasTrailingEol;
  let lineDelta = 0;

  for (const hunk of hunks) {
    const oldLines: string[] = [];
    let newLen = 0;
    let lastOutputIdx = -1;

    for (let idx = 0; idx < hunk.items.length; idx += 1) {
      const it = hunk.items[idx]!;
      if (it.kind === 'ctx') {
        oldLines.push(it.text);
        newLen += 1;
        lastOutputIdx = idx;
      } else if (it.kind === 'del') {
        oldLines.push(it.text);
      } else if (it.kind === 'add') {
        newLen += 1;
        lastOutputIdx = idx;
      }
    }

    const noEolAtEnd =
      lastOutputIdx >= 0 &&
      lastOutputIdx + 1 < hunk.items.length &&
      hunk.items[lastOutputIdx + 1]!.kind === 'no-eol';

    if (oldLines.length === 0) {
      const insertAt = Math.max(0, Math.min(hunk.oldStart + lineDelta, lines.length));
      const atEnd = insertAt === lines.length;
      const toInsert: string[] = [];
      for (const it of hunk.items) {
        if (it.kind === 'add') toInsert.push(it.text);
      }
      if (toInsert.length > 0) {
        lines.splice(insertAt, 0, ...toInsert);
        if (atEnd) hasTrailingEol = !noEolAtEnd;
        lineDelta += toInsert.length;
      }
      continue;
    }

    const found = locatePattern(lines, oldLines, strict);
    if (found === null) throw new EditFailError('no-match', errorPath);

    const targetPos = hunk.oldStart - 1 + lineDelta;
    let bestPos = found.positions[0]!;
    let bestDist = Math.abs(bestPos - targetPos);
    for (let k = 1; k < found.positions.length; k += 1) {
      const cand = found.positions[k]!;
      const dist = Math.abs(cand - targetPos);
      if (dist < bestDist) {
        bestDist = dist;
        bestPos = cand;
      }
    }

    const runsToEnd = bestPos + oldLines.length === lines.length;
    const replacement = renderHunkReplacement(hunk.items, lines, bestPos, oldLines[0]!, found.tier);
    lines.splice(bestPos, oldLines.length, ...replacement);
    if (runsToEnd) hasTrailingEol = !noEolAtEnd;
    lineDelta += newLen - oldLines.length;
  }

  return renderFileText(lines, doc.eol, hasTrailingEol);
}

function applyEdit(tree: VirtualTree, op: EditOp, strict: boolean): void {
  if (op.format === 'unified') {
    if (op.kind === 'create') {
      requireSafe(op.path);
      requireAbsent(tree, op.path);
      const createdLines: string[] = [];
      let noTrailingEol = false;
      for (const hunk of op.hunks) {
        let prevKind: DiffItem['kind'] | null = null;
        for (const it of hunk.items) {
          if (it.kind === 'add') {
            createdLines.push(it.text);
            noTrailingEol = false;
          } else if (it.kind === 'no-eol' && prevKind === 'add') {
            noTrailingEol = true;
          }
          prevKind = it.kind;
        }
      }
      tree.writeNew(op.path, renderFileText(createdLines, '\n', !noTrailingEol));
      return;
    }

    if (op.kind === 'delete') {
      requireSafe(op.path);
      requireExisting(tree, op.path);
      tree.deleteFile(op.path);
      return;
    }

    if (op.kind === 'move') {
      requireSafe(op.oldPath);
      requireSafe(op.newPath);
      const before = requireExisting(tree, op.oldPath);
      requireAbsent(tree, op.newPath);
      const updated = applyUnifiedHunks(parseFileText(before), op.hunks, op.oldPath, strict);
      tree.moveFile(op.oldPath, op.newPath, updated);
      return;
    }

    requireSafe(op.path);
    const before = requireExisting(tree, op.path);
    const updated = applyUnifiedHunks(parseFileText(before), op.hunks, op.path, strict);
    tree.writeExisting(op.path, updated);
    return;
  }

  if (op.format === 'search-replace') {
    requireSafe(op.path);
    if (op.oldLines.length === 0) {
      requireAbsent(tree, op.path);
      tree.writeNew(op.path, renderFileText(op.newLines, '\n', true));
      return;
    }
    const before = requireExisting(tree, op.path);
    const doc = parseFileText(before);
    const found = locatePattern(doc.lines, op.oldLines, strict);
    if (found === null) throw new EditFailError('no-match', op.path);
    if (found.positions.length > 1) throw new EditFailError('ambiguous', op.path);

    const pos = found.positions[0]!;
    let replacement: string[];
    if (found.tier === 2) {
      const fileLead = getLeadingSpacesTabs(doc.lines[pos]!);
      const patchLead = getLeadingSpacesTabs(op.oldLines[0]!);
      replacement = op.newLines.map((l) => reindentForTier2(l, fileLead, patchLead));
    } else {
      replacement = op.newLines;
    }
    doc.lines.splice(pos, op.oldLines.length, ...replacement);
    tree.writeExisting(op.path, renderFileText(doc.lines, doc.eol, doc.hasTrailingEol));
    return;
  }

  if (op.format === 'v4a') {
    if (op.kind === 'add') {
      requireSafe(op.path);
      requireAbsent(tree, op.path);
      tree.writeNew(op.path, renderFileText(op.lines, '\n', true));
      return;
    }

    if (op.kind === 'delete') {
      requireSafe(op.path);
      requireExisting(tree, op.path);
      tree.deleteFile(op.path);
      return;
    }

    requireSafe(op.oldPath);
    if (op.moveTo !== null) requireSafe(op.moveTo);
    const before = requireExisting(tree, op.oldPath);
    if (op.moveTo !== null) requireAbsent(tree, op.moveTo);

    const doc = parseFileText(before);
    const lines = doc.lines;
    let cursor = 0;

    for (const chunk of op.chunks) {
      if (chunk.anchor.length > 0) {
        const anchorMatch = locatePattern(lines, [chunk.anchor], strict, cursor, false);
        if (anchorMatch === null) throw new EditFailError('no-match', op.oldPath);
        cursor = anchorMatch.positions[0]! + 1;
      }

      const oldLines: string[] = [];
      for (const it of chunk.items) {
        if (it.kind === 'ctx' || it.kind === 'del') oldLines.push(it.text);
      }

      if (oldLines.length === 0) {
        const insertAt = chunk.eof ? lines.length : cursor;
        const added: string[] = [];
        for (const it of chunk.items) {
          if (it.kind === 'add') added.push(it.text);
        }
        lines.splice(insertAt, 0, ...added);
        cursor = insertAt + added.length;
      } else {
        const found = locatePattern(lines, oldLines, strict, cursor, chunk.eof);
        if (found === null) throw new EditFailError('no-match', op.oldPath);
        const pos = found.positions[0]!;
        const replacement = renderHunkReplacement(chunk.items, lines, pos, oldLines[0]!, found.tier);
        lines.splice(pos, oldLines.length, ...replacement);
        cursor = pos + replacement.length;
      }
    }

    const outText = renderFileText(lines, doc.eol, doc.hasTrailingEol);
    if (op.moveTo !== null) {
      tree.moveFile(op.oldPath, op.moveTo, outText);
    } else {
      tree.writeExisting(op.oldPath, outText);
    }
    return;
  }

  // JSON operations (Section 9)
  if (op.kind === 'create') {
    requireSafe(op.path);
    requireAbsent(tree, op.path);
    tree.writeNew(op.path, op.fileText);
    return;
  }

  if (op.kind === 'str_replace') {
    requireSafe(op.path);
    const before = requireExisting(tree, op.path);
    const firstLf = before.indexOf('\n');
    const isCrlf = firstLf > 0 && before.charCodeAt(firstLf - 1) === 13;
    const toLf = (s: string): string => (isCrlf ? s.replaceAll('\r\n', '\n') : s);

    const textLf = toLf(before);
    const oldLf = toLf(op.oldStr);
    const firstMatch = textLf.indexOf(oldLf);
    if (firstMatch < 0) throw new EditFailError('no-match', op.path);
    if (textLf.indexOf(oldLf, firstMatch + 1) >= 0) throw new EditFailError('ambiguous', op.path);

    const replaced = textLf.slice(0, firstMatch) + toLf(op.newStr) + textLf.slice(firstMatch + oldLf.length);
    tree.writeExisting(op.path, isCrlf ? replaced.replaceAll('\n', '\r\n') : replaced);
    return;
  }

  // JSON insert
  requireSafe(op.path);
  const before = requireExisting(tree, op.path);
  const doc = parseFileText(before);
  if (op.insertLine < 0 || op.insertLine > doc.lines.length) {
    throw new EditFailError('no-match', op.path);
  }
  doc.lines.splice(op.insertLine, 0, ...op.addLines);
  tree.writeExisting(op.path, renderFileText(doc.lines, doc.eol, doc.hasTrailingEol));
}

// ---------------------------------------------------------------------------
// CLI Entrypoint (Sections 1 & 2)
// ---------------------------------------------------------------------------

interface CliOptions {
  format: CliFormatOption;
  check: boolean;
  strict: boolean;
  patchPath: string | null;
}

function parseCliArgs(argv: string[]): CliOptions | null {
  let format: CliFormatOption | null = null;
  let check = false;
  let strict = false;
  let optionsEnded = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        const val = arg.slice('--format='.length);
        if (format !== null || !VALID_FORMATS.has(val)) return null;
        format = val as CliFormatOption;
      } else if (arg === '--check') {
        if (check) return null;
        check = true;
      } else if (arg === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) return null;
  const patchPath = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  return { format: format ?? 'auto', check, strict, patchPath };
}

function runCli(argv: string[]): { code: number; out: string[] } {
  const opts = parseCliArgs(argv);
  if (opts === null) return { code: 2, out: ['error: usage'] };

  let rawPatch = '';
  try {
    rawPatch = readFileSync(opts.patchPath ?? 0, 'utf8');
  } catch {
    if (opts.patchPath !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = splitPatchLines(rawPatch);
  const format: FormatName | null = opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (format === null) return { code: 2, out: ['error: format'] };

  let ops: EditOp[];
  try {
    if (format === 'unified') ops = parseUnifiedDiff(lines);
    else if (format === 'search-replace') ops = parseSearchReplace(lines);
    else if (format === 'v4a') ops = parseV4aPatch(lines);
    else ops = parseJsonEdits(rawPatch, lines);
    if (ops.length === 0) throw new Exit2Error('error: parse 1');
  } catch (err) {
    if (err instanceof Exit2Error) return { code: 2, out: [err.messageLine] };
    throw err;
  }

  const tree = new VirtualTree();
  const failures: EditFailError[] = [];

  for (const op of ops) {
    const snap = tree.snapshot();
    try {
      applyEdit(tree, op, opts.strict);
    } catch (err) {
      if (!(err instanceof EditFailError)) throw err;
      tree.restore(snap);
      failures.push(err);
    }
  }

  if (failures.length > 0) {
    return {
      code: 1,
      out: [
        ...failures.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${failures.length} of ${ops.length} edits`,
      ],
    };
  }

  return { code: 0, out: tree.commit(opts.check) };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.out.map((line) => `${line}\n`).join(''));
  process.exitCode = result.code;
}
