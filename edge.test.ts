// Comprehensive SPEC.md edge-case test suite for mend.
// Run: node edge.test.ts [filter]

import { runCheck } from './runner.ts';

interface EdgeCase {
  name: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
  expect: {
    exit: number;
    stdout: string;
    files: Record<string, string>;
  };
}

const cases: EdgeCase[] = [
  // ============================================================
  // 1. CLI Invocation & Format Detection
  // ============================================================
  {
    name: 'cli-double-dash-filename-looks-like-option',
    argv: ['--', '--check'],
    stdin: null,
    files: {
      '--check': '{"command":"create","path":"a.txt","file_text":"hi\\n"}\n',
    },
    expect: {
      exit: 0,
      stdout: 'A a.txt\nok: 1 file\n',
      files: {
        '--check': '{"command":"create","path":"a.txt","file_text":"hi\\n"}\n',
        'a.txt': 'hi\n',
      },
    },
  },
  {
    name: 'cli-double-dash-stdin-dash',
    argv: ['--check', '--', '-'],
    stdin: '{"command":"create","path":"a.txt","file_text":"hi\\n"}\n',
    files: {},
    expect: {
      exit: 0,
      stdout: 'A a.txt\nok: 1 file\n',
      files: {},
    },
  },
  {
    name: 'cli-duplicate-option-usage',
    argv: ['--strict', '--strict', '-'],
    stdin: '',
    files: {},
    expect: {
      exit: 2,
      stdout: 'error: usage\n',
      files: {},
    },
  },
  {
    name: 'cli-duplicate-format-usage',
    argv: ['--format=auto', '--format=json'],
    stdin: '',
    files: {},
    expect: {
      exit: 2,
      stdout: 'error: usage\n',
      files: {},
    },
  },
  {
    name: 'cli-usage-beats-no-patch',
    argv: ['--bogus', 'missing.patch'],
    stdin: null,
    files: {},
    expect: {
      exit: 2,
      stdout: 'error: usage\n',
      files: {},
    },
  },
  {
    name: 'cli-directory-as-patch-no-patch',
    argv: ['sub'],
    stdin: null,
    files: { 'sub/a.txt': 'x\n' },
    expect: {
      exit: 2,
      stdout: 'error: no-patch\n',
      files: { 'sub/a.txt': 'x\n' },
    },
  },
  {
    name: 'cli-empty-patch-auto-format-error',
    argv: [],
    stdin: '   \n\t\n',
    files: {},
    expect: {
      exit: 2,
      stdout: 'error: format\n',
      files: {},
    },
  },
  {
    name: 'cli-empty-patch-explicit-unified-parse-1',
    argv: ['--format=unified'],
    stdin: 'just prose\nno diff here\n',
    files: {},
    expect: {
      exit: 2,
      stdout: 'error: parse 1\n',
      files: {},
    },
  },
  {
    name: 'cli-detect-priority-json-over-search-replace',
    argv: [],
    stdin: '{"command":"create","path":"a.txt","file_text":"<<<<<<< SEARCH\\n"}\n',
    files: {},
    expect: {
      exit: 0,
      stdout: 'A a.txt\nok: 1 file\n',
      files: { 'a.txt': '<<<<<<< SEARCH\n' },
    },
  },
  {
    name: 'cli-detect-priority-v4a-over-diff',
    argv: [],
    stdin: '  \n  *** Begin Patch  \n*** Add File: a.txt\n+diff --git a/x b/x\n  *** End Patch  \n',
    files: {},
    expect: {
      exit: 0,
      stdout: 'A a.txt\nok: 1 file\n',
      files: { 'a.txt': 'diff --git a/x b/x\n' },
    },
  },

  // ============================================================
  // 2. CRLF vs LF, Empty Files, No-Trailing-Newline & \ No newline
  // ============================================================
  {
    name: 'eol-crlf-mixed-first-lf-after-cr',
    argv: [],
    stdin: 'a.txt\n<<<<<<< SEARCH\nalpha\n=======\nbeta\n>>>>>>> REPLACE\n',
    files: { 'a.txt': 'alpha\r\ngamma\ndelta\r\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'beta\r\ngamma\ndelta\r\n' },
    },
  },
  {
    name: 'eol-no-trailing-newline-preserved-sr',
    argv: [],
    stdin: 'a.txt\n<<<<<<< SEARCH\nhello\n=======\nworld\n>>>>>>> REPLACE\n',
    files: { 'a.txt': 'hello\nend' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'world\nend' },
    },
  },
  {
    name: 'eol-unified-mid-hunk-preserves-no-final-newline',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n',
    files: { 'a.txt': 'one\ntwo' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'ONE\ntwo' },
    },
  },
  {
    name: 'eol-unified-eof-hunk-adds-final-newline',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+TWO\n',
    files: { 'a.txt': 'one\ntwo' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'one\nTWO\n' },
    },
  },
  {
    name: 'eol-unified-eof-hunk-removes-final-newline',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n\\ No newline at end of file\n',
    files: { 'a.txt': 'one\ntwo\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'one\nTWO' },
    },
  },
  {
    name: 'eol-unified-delete-last-noeol-line-restores-newline',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,1 @@\n one\n-two\n\\ No newline at end of file\n',
    files: { 'a.txt': 'one\ntwo' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'one\n' },
    },
  },
  {
    name: 'eol-unified-keep-last-ctx-noeol',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,1 @@\n-one\n two\n\\ No newline at end of file\n',
    files: { 'a.txt': 'one\ntwo' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'two' },
    },
  },
  {
    name: 'eol-unified-create-without-final-newline',
    argv: [],
    stdin: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+line1\n+line2\n\\ No newline at end of file\n',
    files: {},
    expect: {
      exit: 0,
      stdout: 'A new.txt\nok: 1 file\n',
      files: { 'new.txt': 'line1\nline2' },
    },
  },
  {
    name: 'eol-unified-insert-into-empty-file-with-noeol',
    argv: [],
    stdin: '--- a/empty.txt\n+++ b/empty.txt\n@@ -0,0 +1,1 @@\n+solo\n\\ No newline at end of file\n',
    files: { 'empty.txt': '' },
    expect: {
      exit: 0,
      stdout: 'M empty.txt\nok: 1 file\n',
      files: { 'empty.txt': 'solo' },
    },
  },
  {
    name: 'eol-unified-insert-into-empty-file-with-nl',
    argv: [],
    stdin: '--- a/empty.txt\n+++ b/empty.txt\n@@ -0,0 +1,1 @@\n+solo\n',
    files: { 'empty.txt': '' },
    expect: {
      exit: 0,
      stdout: 'M empty.txt\nok: 1 file\n',
      files: { 'empty.txt': 'solo\n' },
    },
  },
  {
    name: 'eol-unified-delete-all-lines-produces-empty-file',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +0,0 @@\n-one\n-two\n',
    files: { 'a.txt': 'one\ntwo\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': '' },
    },
  },
  {
    name: 'eol-unified-crlf-eof-noeol-transition',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n\\ No newline at end of file\n',
    files: { 'a.txt': 'one\r\ntwo\r\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'one\r\nTWO' },
    },
  },

  // ============================================================
  // 3. Tiered Matching, Ambiguity, Overlapping, Re-indentation (Tabs)
  // ============================================================
  {
    name: 'tier-0-beats-tier-1-ambiguity-in-sr',
    argv: [],
    stdin: 'a.txt\n<<<<<<< SEARCH\nalpha\n=======\nALPHA\n>>>>>>> REPLACE\n',
    files: { 'a.txt': 'alpha  \nalpha\nalpha\t\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'alpha  \nALPHA\nalpha\t\n' },
    },
  },
  {
    name: 'tier-1-ambiguous-in-sr',
    argv: [],
    stdin: 'a.txt\n<<<<<<< SEARCH\nalpha\n=======\nALPHA\n>>>>>>> REPLACE\n',
    files: { 'a.txt': 'alpha  \nalpha\t\n' },
    expect: {
      exit: 1,
      stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': 'alpha  \nalpha\t\n' },
    },
  },
  {
    name: 'tier-2-ambiguous-in-sr',
    argv: [],
    stdin: 'a.txt\n<<<<<<< SEARCH\nalpha\n=======\nALPHA\n>>>>>>> REPLACE\n',
    files: { 'a.txt': '  alpha\n\talpha\n' },
    expect: {
      exit: 1,
      stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': '  alpha\n\talpha\n' },
    },
  },
  {
    name: 'tier-overlapping-matches-sr-ambiguous',
    argv: [],
    stdin: 'a.txt\n<<<<<<< SEARCH\nfoo\nfoo\n=======\nbar\n>>>>>>> REPLACE\n',
    files: { 'a.txt': 'foo\nfoo\nfoo\n' },
    expect: {
      exit: 1,
      stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': 'foo\nfoo\nfoo\n' },
    },
  },
  {
    name: 'tier-2-reindent-tabs-spaces-prefix-and-blank',
    argv: [],
    // Context lines start with ' ' prefix, so 5 leading spaces = prefix ' ' + 4 spaces of content (P = "    ")
    stdin: '--- a/a.go\n+++ b/a.go\n@@ -1,4 +1,6 @@\n     func f() {\n-      a()\n+      b()\n+    \n+  unprefixed()\n+\t\ttabbed()\n     }\n',
    files: { 'a.go': '\t\tfunc f() {\n\t\t  a()\n\t\t}\n' },
    expect: {
      exit: 0,
      stdout: 'M a.go\nok: 1 file\n',
      // F = "\t\t", P = "    " (4 spaces).
      // "      b()" starts with P -> "\t\t  b()"
      // "    " is whitespace-only -> kept as "    "
      // "  unprefixed()" does not start with P -> kept as "  unprefixed()"
      // "\t\ttabbed()" does not start with P -> kept as "\t\ttabbed()"
      // context lines keep file's own lines!
      files: { 'a.go': '\t\tfunc f() {\n\t\t  b()\n    \n  unprefixed()\n\t\ttabbed()\n\t\t}\n' },
    },
  },
  {
    name: 'tier-2-reindent-add-before-first-old-line',
    argv: [],
    stdin: '--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,3 @@\n+  before()\n   first()\n   second()\n',
    files: { 'a.py': '\tfirst()\n\tsecond()\n' },
    expect: {
      exit: 0,
      stdout: 'M a.py\nok: 1 file\n',
      // F = "\t", P = "  ", "+  before()" -> "\tbefore()"
      files: { 'a.py': '\tbefore()\n\tfirst()\n\tsecond()\n' },
    },
  },
  {
    name: 'tier-2-reindent-sr-with-tabs',
    argv: [],
    stdin: 'a.go\n<<<<<<< SEARCH\n  x := 1\n  y := 2\n=======\n  x := 10\n    y := 20\n\nno_prefix\n>>>>>>> REPLACE\n',
    files: { 'a.go': '\t\tx := 1\n\t\ty := 2\n' },
    expect: {
      exit: 0,
      stdout: 'M a.go\nok: 1 file\n',
      files: { 'a.go': '\t\tx := 10\n\t\t  y := 20\n\nno_prefix\n' },
    },
  },
  {
    name: 'strict-rejects-tier-1-in-sr',
    argv: ['--strict'],
    stdin: 'a.txt\n<<<<<<< SEARCH\nhello\n=======\nworld\n>>>>>>> REPLACE\n',
    files: { 'a.txt': 'hello \n' },
    expect: {
      exit: 1,
      stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': 'hello \n' },
    },
  },
  {
    name: 'strict-rejects-tier-2-anchor-in-v4a',
    argv: ['--strict'],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n@@ def f():\n-x\n+y\n*** End Patch\n',
    files: { 'a.txt': '  def f():\nx\n' },
    expect: {
      exit: 1,
      stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': '  def f():\nx\n' },
    },
  },

  // ============================================================
  // 4. Unified Diff Edge Cases
  // ============================================================
  {
    name: 'unified-tie-break-equally-near-picks-earlier',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -3,1 +3,1 @@\n-dup\n+NEW\n',
    // lines: 0:dup, 1:mid, 2:mid, 3:mid, 4:dup -> target = 3-1+0 = 2; dist(0,2)=2, dist(4,2)=2 -> earlier (0)
    files: { 'a.txt': 'dup\nmid\nmid\nmid\ndup\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'NEW\nmid\nmid\nmid\ndup\n' },
    },
  },
  {
    name: 'unified-d-shift-accumulates-across-hunks',
    argv: [],
    // Hunk 1 adds 3 lines at top (d = +3). Hunk 2 says @@ -2,1 +5,1 @@ -> target = 2-1+3 = 4!
    // Positions of "x": 0 (dist 4) vs 5 (dist 1) -> picks index 5!
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,4 @@\n-top\n+t1\n+t2\n+t3\n+t4\n@@ -2,1 +5,1 @@\n-x\n+X\n',
    files: { 'a.txt': 'top\nmid\nx\nmid\nmid\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 't1\nt2\nt3\nt4\nmid\nX\nmid\nmid\n' },
    },
  },
  {
    name: 'unified-header-tab-timestamp-and-b-prefix-on-minus',
    argv: [],
    stdin: '--- b/a.txt\t2026-11-24 12:00:00\n+++ a/a.txt\t2026-11-24 12:01:00\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    files: { 'a.txt': 'old\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'new\n' },
    },
  },
  {
    name: 'unified-pure-rename-no-hunks',
    argv: [],
    stdin: 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n',
    files: { 'old.txt': 'hello\n' },
    expect: {
      exit: 0,
      stdout: 'R old.txt -> new.txt\nok: 1 file\n',
      files: { 'new.txt': 'hello\n' },
    },
  },
  {
    name: 'unified-empty-new-file-mode-no-hunks',
    argv: [],
    stdin: 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n',
    files: {},
    expect: {
      exit: 0,
      stdout: 'A empty.txt\nok: 1 file\n',
      files: { 'empty.txt': '' },
    },
  },
  {
    name: 'unified-delete-ignores-mismatched-hunks',
    argv: [],
    stdin: 'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-completely wrong content\n',
    files: { 'gone.txt': 'actual content\n' },
    expect: {
      exit: 0,
      stdout: 'D gone.txt\nok: 1 file\n',
      files: {},
    },
  },
  {
    name: 'unified-parse-error-minus-without-plus-in-header',
    argv: [],
    stdin: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    files: { 'a.txt': 'a\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 3\n',
      files: { 'a.txt': 'a\n' },
    },
  },
  {
    name: 'unified-parse-error-minus-at-eof-in-header',
    argv: [],
    stdin: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n',
    files: { 'a.txt': 'a\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 3\n',
      files: { 'a.txt': 'a\n' },
    },
  },
  {
    name: 'unified-parse-error-bad-diff-git-tab',
    argv: ['--format=unified'],
    stdin: 'diff --git\ta/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    files: { 'a.txt': 'a\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 1\n',
      files: { 'a.txt': 'a\n' },
    },
  },
  {
    name: 'unified-parse-error-hunk-before-section',
    argv: ['--format=unified'],
    stdin: '@@ -1,1 +1,1 @@\n-a\n+b\n',
    files: {},
    expect: {
      exit: 2,
      stdout: 'error: parse 1\n',
      files: {},
    },
  },
  {
    name: 'unified-multi-hunk-second-fails-changes-nothing',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n@@ -2,1 +2,1 @@\n-missing\n+X\n',
    files: { 'a.txt': 'one\ntwo\n' },
    expect: {
      exit: 1,
      stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': 'one\ntwo\n' },
    },
  },

  // ============================================================
  // 5. SEARCH/REPLACE Edge Cases
  // ============================================================
  {
    name: 'sr-malformed-block1-missing-eq-before-block2',
    argv: [],
    stdin: 'a.txt\n<<<<<<< SEARCH\nold1\n>>>>>>> REPLACE\nb.txt\n<<<<<<< SEARCH\nold2\n=======\nnew2\n>>>>>>> REPLACE\n',
    files: { 'a.txt': 'old1\n', 'b.txt': 'old2\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 2\n',
      files: { 'a.txt': 'old1\n', 'b.txt': 'old2\n' },
    },
  },
  {
    name: 'sr-malformed-block1-missing-replace-before-block2',
    argv: [],
    stdin: 'a.txt\n<<<<<<< SEARCH\nold1\n=======\nnew1\nb.txt\n<<<<<<< SEARCH\nold2\n=======\nnew2\n>>>>>>> REPLACE\n',
    files: { 'a.txt': 'old1\n', 'b.txt': 'old2\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 2\n',
      files: { 'a.txt': 'old1\n', 'b.txt': 'old2\n' },
    },
  },
  {
    name: 'sr-create-empty-file',
    argv: [],
    stdin: 'empty.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n',
    files: {},
    expect: {
      exit: 0,
      stdout: 'A empty.txt\nok: 1 file\n',
      files: { 'empty.txt': '' },
    },
  },
  {
    name: 'sr-path-inheritance-across-fences',
    argv: [],
    stdin: 'a.txt\n```txt\n<<<<<<< SEARCH\none\n=======\nONE\n>>>>>>> REPLACE\n```\n\n```txt\n<<<<<<< SEARCH\ntwo\n=======\nTWO\n>>>>>>> REPLACE\n```\n',
    files: { 'a.txt': 'one\ntwo\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'ONE\nTWO\n' },
    },
  },

  // ============================================================
  // 6. V4A Edge Cases
  // ============================================================
  {
    name: 'v4a-anchor-tier0-beats-earlier-tier2',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n@@ target\n-val\n+VAL\n*** End Patch\n',
    // line 0 is "  target" (tier 2), line 1 is "val", line 2 is "target" (tier 0), line 3 is "val"
    // Anchor must pick line 2 (tier 0), so cursor=3, replaces line 3!
    files: { 'a.txt': '  target\nval\ntarget\nval\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': '  target\nval\ntarget\nVAL\n' },
    },
  },
  {
    name: 'v4a-eof-matches-only-last-lines-not-earlier',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n-dup\n+END\n*** End of File\n*** End Patch\n',
    files: { 'a.txt': 'dup\nmid\ndup\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'dup\nmid\nEND\n' },
    },
  },
  {
    name: 'v4a-eof-fails-when-only-earlier',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n-dup\n+END\n*** End of File\n*** End Patch\n',
    files: { 'a.txt': 'dup\nlast\n' },
    expect: {
      exit: 1,
      stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': 'dup\nlast\n' },
    },
  },
  {
    name: 'v4a-eof-empty-old-appends-at-end',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n@@\n+appended\n*** End of File\n*** End Patch\n',
    files: { 'a.txt': 'one\ntwo\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'one\ntwo\nappended\n' },
    },
  },
  {
    name: 'v4a-empty-old-with-anchor-inserts-after-anchor',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n@@ header\n+inserted\n*** End Patch\n',
    files: { 'a.txt': 'header\nbody\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'header\ninserted\nbody\n' },
    },
  },
  {
    name: 'v4a-pure-move-no-chunks',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: sub/b.txt\n*** End Patch\n',
    files: { 'a.txt': 'keep\r\nexact' },
    expect: {
      exit: 0,
      stdout: 'R a.txt -> sub/b.txt\nok: 1 file\n',
      files: { 'sub/b.txt': 'keep\r\nexact' },
    },
  },
  {
    name: 'v4a-update-no-chunk-no-move-parse-error',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n',
    files: { 'a.txt': 'x\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 2\n',
      files: { 'a.txt': 'x\n' },
    },
  },
  {
    name: 'v4a-delete-with-body-parse-error',
    argv: [],
    stdin: '*** Begin Patch\n*** Delete File: a.txt\n-x\n*** End Patch\n',
    files: { 'a.txt': 'x\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 3\n',
      files: { 'a.txt': 'x\n' },
    },
  },
  {
    name: 'v4a-add-empty-file',
    argv: [],
    stdin: '*** Begin Patch\n*** Add File: empty.txt\n*** End Patch\n',
    files: {},
    expect: {
      exit: 0,
      stdout: 'A empty.txt\nok: 1 file\n',
      files: { 'empty.txt': '' },
    },
  },

  // ============================================================
  // 7. JSON Edge Cases
  // ============================================================
  {
    name: 'json-str-replace-overlapping-ambiguous',
    argv: [],
    stdin: '{"command":"str_replace","path":"a.txt","old_str":"aa","new_str":"b"}\n',
    files: { 'a.txt': 'aaa\n' },
    expect: {
      exit: 1,
      stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': 'aaa\n' },
    },
  },
  {
    name: 'json-str-replace-absent-new-str-deletes',
    argv: [],
    stdin: '{"command":"str_replace","path":"a.txt","old_str":"world"}\n',
    files: { 'a.txt': 'hello world!\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'hello !\n' },
    },
  },
  {
    name: 'json-str-replace-crlf-normalization',
    argv: [],
    stdin: '{"command":"str_replace","path":"a.txt","old_str":"a\\nb","new_str":"x\\ny"}\n',
    files: { 'a.txt': 'a\r\nb\r\nc\r\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'x\r\ny\r\nc\r\n' },
    },
  },
  {
    name: 'json-insert-empty-file-preserves-no-final-break',
    argv: [],
    stdin: '{"command":"insert","path":"a.txt","insert_line":0,"new_str":"first\\nsecond\\n"}\n',
    files: { 'a.txt': '' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'first\nsecond' },
    },
  },
  {
    name: 'json-array-parse-error-reports-array-start-line',
    argv: [],
    stdin: '\n\n[\n  {"command":"create","path":"a.txt","file_text":"ok"},\n  {"command":"bad","path":"b.txt"}\n]\n',
    files: {},
    expect: {
      exit: 2,
      stdout: 'error: parse 3\n',
      files: {},
    },
  },

  // ============================================================
  // 8. Move / Delete / Recreate / Swap / Dir-File Collision / Unsafe / Atomicity
  // ============================================================
  {
    name: 'seq-dir-to-file-collision',
    argv: [],
    stdin: '*** Begin Patch\n*** Delete File: foo/bar.txt\n*** Add File: foo\n+now a file\n*** End Patch\n',
    files: { 'foo/bar.txt': 'inside dir\n' },
    expect: {
      exit: 0,
      stdout: 'A foo\nD foo/bar.txt\nok: 2 files\n',
      files: { 'foo': 'now a file\n' },
    },
  },
  {
    name: 'seq-file-to-dir-collision',
    argv: [],
    stdin: '*** Begin Patch\n*** Delete File: foo\n*** Add File: foo/bar.txt\n+now inside dir\n*** End Patch\n',
    files: { 'foo': 'was a file\n' },
    expect: {
      exit: 0,
      stdout: 'D foo\nA foo/bar.txt\nok: 2 files\n',
      files: { 'foo/bar.txt': 'now inside dir\n' },
    },
  },
  {
    name: 'seq-move-then-recreate-old-same-bytes',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Add File: a.txt\n+hello\n*** End Patch\n',
    files: { 'a.txt': 'hello\n' },
    expect: {
      exit: 0,
      stdout: 'A b.txt\nok: 1 file\n',
      files: { 'a.txt': 'hello\n', 'b.txt': 'hello\n' },
    },
  },
  {
    name: 'seq-move-then-recreate-old-diff-bytes',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Add File: a.txt\n+brand new\n*** End Patch\n',
    files: { 'a.txt': 'hello\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nA b.txt\nok: 2 files\n',
      files: { 'a.txt': 'brand new\n', 'b.txt': 'hello\n' },
    },
  },
  {
    name: 'seq-delete-target-then-move-into-it',
    argv: [],
    stdin: '*** Begin Patch\n*** Delete File: b.txt\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n',
    files: { 'a.txt': 'from a\n', 'b.txt': 'from b\n' },
    expect: {
      exit: 0,
      stdout: 'D a.txt\nM b.txt\nok: 2 files\n',
      files: { 'b.txt': 'from a\n' },
    },
  },
  {
    name: 'seq-move-chain-a-to-b-to-c',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Update File: b.txt\n*** Move to: c.txt\n*** End Patch\n',
    files: { 'a.txt': 'data\n' },
    expect: {
      exit: 0,
      stdout: 'D a.txt\nA c.txt\nok: 2 files\n',
      files: { 'c.txt': 'data\n' },
    },
  },
  {
    name: 'seq-move-roundtrip-noop',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Update File: b.txt\n*** Move to: a.txt\n*** End Patch\n',
    files: { 'a.txt': 'data\n' },
    expect: {
      exit: 0,
      stdout: 'ok: 0 files\n',
      files: { 'a.txt': 'data\n' },
    },
  },
  {
    name: 'seq-swap-two-files-via-tmp',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: tmp.txt\n*** Update File: b.txt\n*** Move to: a.txt\n*** Update File: tmp.txt\n*** Move to: b.txt\n*** End Patch\n',
    files: { 'a.txt': 'AAA\n', 'b.txt': 'BBB\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nM b.txt\nok: 2 files\n',
      files: { 'a.txt': 'BBB\n', 'b.txt': 'AAA\n' },
    },
  },
  {
    name: 'seq-create-then-delete-noop',
    argv: [],
    stdin: '*** Begin Patch\n*** Add File: temp.txt\n+hi\n*** Delete File: temp.txt\n*** End Patch\n',
    files: {},
    expect: {
      exit: 0,
      stdout: 'ok: 0 files\n',
      files: {},
    },
  },
  {
    name: 'seq-rename-sorts-by-new-path-utf8-byte-order',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: z.txt\n*** Move to: A.txt\n*** Add File: a.txt\n+x\n*** End Patch\n',
    // UTF-8 byte order: 'A.txt' (0x41) < 'a.txt' (0x61)
    files: { 'z.txt': 'from z\n' },
    expect: {
      exit: 0,
      stdout: 'R z.txt -> A.txt\nA a.txt\nok: 2 files\n',
      files: { 'A.txt': 'from z\n', 'a.txt': 'x\n' },
    },
  },
  {
    name: 'unsafe-checked-before-missing-or-exists',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: nonexistent.txt\n*** Move to: ../escape.txt\n*** Delete File: ./dot.txt\n*** Add File: a//b.txt\n+x\n*** Add File: a\\b.txt\n+x\n*** End Patch\n',
    files: {},
    expect: {
      exit: 1,
      stdout: 'error: unsafe ../escape.txt\nerror: unsafe ./dot.txt\nerror: unsafe a//b.txt\nerror: unsafe a\\b.txt\nfailed: 4 of 4 edits\n',
      files: {},
    },
  },
  {
    name: 'unsafe-unified-reports-after-prefix-strip',
    argv: [],
    stdin: '--- a/../secret.txt\n+++ b/../secret.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    files: {},
    expect: {
      exit: 1,
      stdout: 'error: unsafe ../secret.txt\nfailed: 1 of 1 edits\n',
      files: {},
    },
  },
  {
    name: 'atomicity-multi-edit-partial-failure-writes-nothing',
    argv: [],
    stdin: [
      '*** Begin Patch',
      '*** Add File: created.txt',
      '+should not be written',
      '*** Update File: a.txt',
      '-nonexistent',
      '+nope',
      '*** Update File: created.txt',
      '-should not be written',
      '+still sees earlier success',
      '*** Delete File: missing.txt',
      '*** End Patch',
      '',
    ].join('\n'),
    files: { 'a.txt': 'real\n' },
    expect: {
      exit: 1,
      stdout: 'error: no-match a.txt\nerror: missing missing.txt\nfailed: 2 of 4 edits\n',
      files: { 'a.txt': 'real\n' },
    },
  },

  // ============================================================
  // 9. Deep Spec Hardening Cases (Round 2 Revision)
  // ============================================================
  {
    name: 'v4a-delete-blank-then-garbage-reports-garbage-line',
    argv: [],
    stdin: '*** Begin Patch\n*** Delete File: a.txt\n\ngarbage\n*** End Patch\n',
    files: { 'a.txt': 'x\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 4\n',
      files: { 'a.txt': 'x\n' },
    },
  },
  {
    name: 'v4a-cursor-advances-past-first-match-and-forbids-backtrack',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n@@\n-second\n+SECOND\n@@\n-first\n+FIRST\n*** End Patch\n',
    files: { 'a.txt': 'first\nsecond\nthird\n' },
    expect: {
      exit: 1,
      stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': 'first\nsecond\nthird\n' },
    },
  },
  {
    name: 'v4a-move-nomatch-reports-old-path',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n-nope\n+yes\n*** End Patch\n',
    files: { 'old.txt': 'real\n' },
    expect: {
      exit: 1,
      stdout: 'error: no-match old.txt\nfailed: 1 of 1 edits\n',
      files: { 'old.txt': 'real\n' },
    },
  },
  {
    name: 'v4a-move-to-same-path-exists',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: a.txt\n*** End Patch\n',
    files: { 'a.txt': 'hi\n' },
    expect: {
      exit: 1,
      stdout: 'error: exists a.txt\nfailed: 1 of 1 edits\n',
      files: { 'a.txt': 'hi\n' },
    },
  },
  {
    name: 'v4a-eof-then-second-explicit-chunk',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n-end\n+END\n*** End of File\n@@\n+tail\n*** End of File\n*** End Patch\n',
    files: { 'a.txt': 'start\nend\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'start\nEND\ntail\n' },
    },
  },
  {
    name: 'v4a-eof-then-bare-body-parse-error',
    argv: [],
    stdin: '*** Begin Patch\n*** Update File: a.txt\n-end\n+END\n*** End of File\n+illegal\n*** End Patch\n',
    files: { 'a.txt': 'start\nend\n' },
    expect: {
      exit: 2,
      stdout: 'error: parse 6\n',
      files: { 'a.txt': 'start\nend\n' },
    },
  },
  {
    name: 'unified-diff-git-move-without-minus-plus',
    argv: [],
    stdin: 'diff --git a/old.txt b/new.txt\n@@ -1,1 +1,1 @@\n-hello\n+HELLO\n',
    files: { 'old.txt': 'hello\n' },
    expect: {
      exit: 0,
      stdout: 'R old.txt -> new.txt\nok: 1 file\n',
      files: { 'new.txt': 'HELLO\n' },
    },
  },
  {
    name: 'unified-bare-minus-plus-move',
    argv: [],
    stdin: '--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-hello\n+HELLO\n',
    files: { 'old.txt': 'hello\n' },
    expect: {
      exit: 0,
      stdout: 'R old.txt -> new.txt\nok: 1 file\n',
      files: { 'new.txt': 'HELLO\n' },
    },
  },
  {
    name: 'unified-single-strip-of-a-and-b-prefix',
    argv: [],
    stdin: '--- a/a/foo.txt\n+++ b/a/foo.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n',
    files: { 'a/foo.txt': 'x\n' },
    expect: {
      exit: 0,
      stdout: 'M a/foo.txt\nok: 1 file\n',
      files: { 'a/foo.txt': 'y\n' },
    },
  },
  {
    name: 'unified-mid-file-noeol-does-not-strip-final-break',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n\\ No newline at end of file\n',
    files: { 'a.txt': 'one\ntwo\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'ONE\ntwo\n' },
    },
  },
  {
    name: 'unified-empty-o-mid-insert-preserves-no-final-break',
    argv: [],
    stdin: '--- a/a.txt\n+++ b/a.txt\n@@ -1,0 +2,1 @@\n+inserted\n',
    files: { 'a.txt': 'one\ntwo' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'one\ninserted\ntwo' },
    },
  },
  {
    name: 'sr-crlf-patch-on-lf-file-preserves-lf',
    argv: [],
    stdin: 'a.txt\r\n<<<<<<< SEARCH\r\none\r\n=======\r\nONE\r\nTWO\r\n>>>>>>> REPLACE\r\n',
    files: { 'a.txt': 'one\nthree\n' },
    expect: {
      exit: 0,
      stdout: 'M a.txt\nok: 1 file\n',
      files: { 'a.txt': 'ONE\nTWO\nthree\n' },
    },
  },
  {
    name: 'sr-markdown-equals-inside-replacement-allowed',
    argv: [],
    stdin: 'README.md\n<<<<<<< SEARCH\nOld\n---\n=======\nNew\n=======\n>>>>>>> REPLACE\n',
    files: { 'README.md': 'Old\n---\nBody\n' },
    expect: {
      exit: 0,
      stdout: 'M README.md\nok: 1 file\n',
      files: { 'README.md': 'New\n=======\nBody\n' },
    },
  },
  {
    name: 'seq-nested-dir-tree-replaced-by-file',
    argv: [],
    stdin: '*** Begin Patch\n*** Delete File: a/b/c.txt\n*** Delete File: a/b/d.txt\n*** Add File: a\n+flat\n*** End Patch\n',
    files: { 'a/b/c.txt': '1\n', 'a/b/d.txt': '2\n' },
    expect: {
      exit: 0,
      stdout: 'A a\nD a/b/c.txt\nD a/b/d.txt\nok: 3 files\n',
      files: { 'a': 'flat\n' },
    },
  },
  {
    name: 'json-insert-bounds-and-extra-keys-ignored',
    argv: [],
    stdin: [
      '{"command":"insert","path":"a.txt","insert_line":2,"new_str":"end","extra":123}',
      '{"command":"insert","path":"a.txt","insert_line":0,"new_str":""}',
      '{"command":"insert","path":"a.txt","insert_line":4,"new_str":"oob"}',
      '',
    ].join('\n'),
    files: { 'a.txt': 'one\ntwo\n' },
    expect: {
      exit: 1,
      stdout: 'error: no-match a.txt\nfailed: 1 of 3 edits\n',
      files: { 'a.txt': 'one\ntwo\n' },
    },
  },
];

const filter = process.argv[2];
const picked = filter ? cases.filter((c) => c.name.includes(filter)) : cases;
let passed = 0;

for (const c of picked) {
  const got = runCheck({ id: c.name, argv: c.argv, stdin: c.stdin, files: c.files });
  const why: string[] = [];
  if (got.exit !== c.expect.exit) why.push(`exit ${got.exit}, expected ${c.expect.exit}`);
  if (got.stdout !== c.expect.stdout) why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(c.expect.stdout)}`);
  for (const p of new Set([...Object.keys(c.expect.files), ...Object.keys(got.files)])) {
    if (c.expect.files[p] === undefined) why.push(`${p} should not exist`);
    else if (got.files[p] === undefined) why.push(`${p} is missing`);
    else if (got.files[p] !== c.expect.files[p]) {
      why.push(`${p} differs: expected ${JSON.stringify(c.expect.files[p])}, got ${JSON.stringify(got.files[p])}`);
    }
  }
  if (why.length === 0) {
    passed += 1;
  } else {
    process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
  }
}

process.stdout.write(`edge tests: ${passed} of ${picked.length} passed\n`);
if (passed !== picked.length) process.exitCode = 1;
