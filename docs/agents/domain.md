# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repo root, if it exists.
- `docs/adr/` for decisions that touch the area being changed, if it exists.

If these files do not exist, proceed silently. Create them lazily when domain terms or durable decisions are resolved.

## File structure

This is a single-context repository:

```
/
├── CONTEXT.md
└── docs/
    └── adr/
```

## Use the glossary vocabulary

Use terms from `CONTEXT.md` when naming domain concepts. Flag conflicts instead of silently introducing synonyms.
