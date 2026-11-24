# mend

One patch tool for every AI edit format. `mend` reads a patch in one of four formats, finds the lines each edit
names, and writes every change or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- Formats: unified diff, SEARCH/REPLACE blocks, V4A patches and JSON edits (`str_replace`, `create`, `insert`),
  detected automatically or named with `--format=unified|search-replace|v4a|json`.
- Matching: each edit's old lines are found at the first of three tiers: exact, trailing whitespace ignored,
  leading and trailing whitespace ignored. At the third tier the replacement is re-indented to the file's own
  indentation. `--strict` allows only the exact tier.
- Atomic: when any edit fails, every failure is reported and no file is touched. `--check` does everything but write.
- Output: `A`, `D`, `M` and `R old -> new` lines in byte order of the path, then `ok: N files`; failures print
  `error: <code> <path>` and `failed: k of n edits`.
- Files keep their own line breaks (CRLF or LF) and their final line break unless the patch says otherwise.

Node 22 and its standard library only; no install step. `runner.ts` hands a trial from the make.fun harness to the
CLI and is kept as the kit provides it.

MIT licensed.
