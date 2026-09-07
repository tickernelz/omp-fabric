# Code map

Fabric reads code structurally. `codemap.map` returns a symbol index under an explicit token budget; `codemap.cascade` ranks files by how often they historically changed together with a seed.

Both are read-only and always safe to call.

## Why this exists next to OMP's own tools

OMP already covers two of the three layers, and Fabric deliberately does not duplicate them:

| Layer | Owner |
| --- | --- |
| Fold one file's bodies, keep its declarations | OMP `read` (tree-sitter `summarizeCode`, cached per session) |
| Find a symbol or pattern across files | OMP `ast_grep`, `grep` |
| Follow one symbol's real call edges | OMP `lsp` references, definition, implementation |
| **Rank a whole repo under a token budget** | **`codemap.map`** |
| **Predict which files a change drags along** | **`codemap.cascade`** |

`lsp references` is more accurate than any static graph for "who calls X" because it follows shadowing and re-exports. Use it for that. Use `codemap` when the question is which files matter at all, before you know the symbol to ask about.

## Density

The index is built with the host's native ast-grep binding (`astGrep` from `@oh-my-pi/pi-natives`) using per-language declaration patterns with `$NAME` metavariable capture. It emits `<line> <letter> <name>` grouped by a bare file-path header, preceded once by a legend line, so it carries symbol identity in place of signature text.

Measured on this repository at the 1.2.0 tag, all rows on the same corpus of 293 TypeScript files and 3,412,131 raw bytes:

| Approach | Bytes | Compression |
| --- | ---: | ---: |
| Raw source | 3,412,131 | 1.00x |
| `summarizeCode`, unfiltered | 543,028 | 6.28x |
| `summarizeCode`, imports and comments dropped | 417,367 | 8.18x |
| `ast-grep outline` CLI 0.45.3 | 313,626 | 10.88x |
| **Native `astGrep` symbol index** | **210,675** | **16.20x** |

The shipped map is 1.49x denser than the `ast-grep outline` CLI while needing no extra dependency. Spelling the kind as a full word costs that lead: the same index renders to 249,161 bytes, a 13.69x compression, which is why the legend exists.

Reproduce every row except the CLI one with `bun run benchmark:codemap`, which fails below a 15x floor. The CLI row needs `ast-grep` on PATH and is not part of the gate.

The native path was chosen over the `ast-grep` CLI because it is denser, needs no new dependency, and reuses a binding the host already loads. Languages without a pattern entry fall back to filtered `summarizeCode`, so coverage extends past the pattern table.

## What gets indexed

Inside a git repository the file list comes from `git ls-files --cached --others --exclude-standard`, so tracked and untracked files are indexed while ignored ones are skipped. Build output, vendored trees, and benchmark artifacts stay out of the map without any configuration. Outside a git repository, or when git is unavailable, the index falls back to a filesystem walk that skips `node_modules`, `dist`, and dot-directories.

This matters more than it sounds. Indexing this repository at its root without the git filter found 3,425 files, most of them gitignored benchmark checkouts; with the filter it finds 542.

## Budgeted disclosure

A full index of a large repository does not fit a sensible context slice, so `codemap.map` ranks before it spends:

1. `focus` scores files against a task description or symbol name, weighting whole-word matches above substrings.
2. `seeds` adds git co-change affinity, so a file related by history surfaces even when its name shares nothing with the query.
3. With neither, ordering is deterministic (symbol count descending, then path) so repeated calls return identical text.

Budget is then spent file by file in rank order. Inside a file that does not fit whole, exported symbols win the remaining slots. `omittedFiles` and `omittedSymbols` report exactly what was left out; `truncated` is true if and only if something was.

```ts
const map = await codemap.map({ focus: "compaction threshold", maxTokens: 4000 });
const related = await codemap.cascade({ seeds: ["src/core/compact-controller.ts"] });
```

## Co-change ranking

`codemap.cascade` reads bounded `git log` history and scores candidates by symmetric affinity in place of raw co-occurrence:

```
score = shared / sqrt(seedCommits * candidateCommits)
```

Raw counting would rank lockfiles, changelogs, and version files first, because they appear in nearly every commit. Normalising by each file's own commit count removes that bias. Merge commits are excluded, and so are commits touching more than a bulk-commit ceiling of files, because a vendored sweep or a formatter run would otherwise invent affinity between every file it touched.

When the workspace is not a git repository, or history is empty, the call returns a well-formed empty graph with `unavailable` set. It never throws.

## Configuration

```json
{
  "codemap": {
    "enabled": true,
    "maxFiles": 4000,
    "maxSymbols": 40000,
    "defaultMaxTokens": 8000,
    "cascadeCommits": 600,
    "cascadeLimit": 24
  }
}
```

The index is cached per workspace root for 30 seconds; pass `refresh: true` to rebuild it after large edits. Set `enabled: false` to remove `codemap.*` from the guest surface entirely.
