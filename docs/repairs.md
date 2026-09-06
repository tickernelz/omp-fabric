# Catalog repairs

OMP Fabric learns **silent catalog-argument repairs** from unique invocation near-misses. It does not rewrite guidelines, `AGENTS.md`, or the system prompt. Session JSONL remains the only log. The durable product is a catalog-scoped table of spilled→declared maps.

KPI: repeat **invocation** fingerprints → 0. Bash nonzero, edit misses, missing files, and guest typecheck/syntax are classified for status but never promoted.

## Loop

```text
invalid args / unknown action
        │
  unique bijection against the live schema
        │
        ├─ effect / didactic / typecheck  → count, do not promote
        └─ unique extra key or unique verb → insert into current.json
                │
         next ActionRegistry prepare / resolve applies the row
         (canonical input is a no-op)
```

Repair-candidate observation and apply happen in `ActionRegistry` only. Unique extra keys are observed on the **caller's spilled args** before `prepareArguments`, so a bundled lexicon repair still persists the map for providers that lack one. `tool_execution_end` records effect drops and non-promotable fingerprints without double-counting inner invocation errors.

## Store

`<active OMP agent dir>/fabric/repairs/current.json` (`OMP_FABRIC_AGENT_DIR` overrides the agent dir).

`catalogDigest` hashes sorted provider names plus captured tool names. A digest change starts empty and **clears in-memory fingerprint counters** so a previous candidate cannot be re-inserted. Schema field/action renames do not bump the digest; apply re-proves each row's unique mapping against the **live** declared names instead. Repairs are **global across models**, not per project.

Table rows:

- `keyAlias`: extra argument key → declared key (`sessionId` → `session`)
- `actionAlias`: spilled action name → declared name (never applied when a committed capability view pins the call)

Cap: 256 rows. Promotion is on the first unique hit; uniqueness against the
live schema is the bound. A promoted row becomes active in memory immediately,
while persistence queues behind a single asynchronous writer. Insert is
identity-keyed (idempotent) and locked across OMP processes sharing the agent
directory; lock retries yield to the event loop, and stale-lock recovery is an
exclusive rename claim, so racing reapers can never delete a lock a fresh
writer owns. Queued writes merge with rows another process persisted and flush
before runtime teardown. Persistence failures never fail or delay the user's
invocation and appear in `/fabric repairs`. Apply is a no-op when the schema
accepts extension keys, the live mapping is absent or ambiguous, or the call is
already canonical.

Two failure modes stay visible, never silent:

- A **transient catalog** (capture suspension between sessions or during `/fabric reload`) never re-keys the table: the surface freezes until the catalog re-arms, so promotion cannot persist rows under an empty-catalog digest that would destroy the stable table.
- A **damaged table** (unreadable or malformed `current.json`) surfaces as `storeError` in `/fabric repairs`, blocks the merge that would overwrite it, and keeps promoted rows active in memory. A missing table, or one persisted under a different digest, starts fresh without an error.

## Commands

```text
/fabric repairs              # status, top fingerprints, current table
```

## Configuration

```json
{
  "repairs": {
    "enabled": true
  }
}
```

Disable with `"enabled": false`. Promotion never edits execution guidance or Schema text.

The repair table is the profiler for [tool entropy](entropy.md): the deterministic meter, ratchet gate, and `certify:entropy` compiler loop turn promoted rows into reviewable surface diffs.
