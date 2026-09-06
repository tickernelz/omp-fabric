# AGENTS.md

## Golden rule: build when done

Always finish a change with a fresh build before handing it back:

```sh
bun run build
```

OMP loads and publishes the compiled bundle in `dist/` — not `src/`. Tests run
against `src/`, so green tests alone are not enough: without a build the
change is invisible in the TUI and unpublished. Rebuild so the user can
verify immediately.

## Before committing

```sh
bun run check
```

This runs typecheck, build, the full test suite, and dead-code lint. Keep it
green; a build alone is not completion.

## Incremental checks while iterating

The full suite takes ~2 minutes; don't pay that on every small change. For
fast inner loops use:

```sh
bun run check:fast    # typecheck + only tests affected by uncommitted changes
bun run test:changed  # tests affected by changes vs HEAD
bun run test:related -- src/ui/settings.ts   # tests importing given files
```

`test:changed` is git-driven (dirty `src/`/`tests/` files → `vitest related`);
it avoids the vitest `--changed` pitfall where a dirty `package.json` forces
the entire suite to run.

Use these while iterating. Always run the full `bun run check` before
committing — incremental runs do not cover build, lazy-graph assertions,
unrelated tests, or dead-code lint.

## Package manager

This repo is bun-managed (`bun.lock`; scripts invoke `bun run` internally).
Do not use pnpm/npm — pnpm's pre-run dependency check fails against the bun
lockfile.

## Commits

Use conventional commits (commitlint): `feat(scope): ...`, `fix(scope): ...`,
`chore(release): <version>` for version bumps.
