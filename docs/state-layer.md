# State layer (fabric-schema)

The `state` provider adds a typed, labeled world-model layer over mesh storage. It records claims, executable evidence attached to transitions, verification outcomes, and compare-and-swap state changes. On its own it gives durable process state and fail-closed reporting. With the default `schema.mode: "off"`, it does not gate direct OMP tools such as `omp.edit`, `omp.bash`,.

The separate opt-in Schema transaction layer adds `audit` and `enforce` modes. Enforce mode keeps state reads available and blocks `state.transition`, `state.verify`, `state.goal`, and `state.checkGoal` from model-originated calls. Mutations then go through the host-owned `schema.*` transaction control plane. See [Schema enforcement](./schema-enforcement.md).

## Claim, evidence attachment, and certification

Keep these states separate:

1. A **claim** is the transition `summary` plus its labeled move from one world-model state to another.
2. **Evidence attachment** stores shell commands on the transition. Attachment means the commands can be replayed. It says nothing about whether they ran or passed.
3. **Certification** happens only when `state.verify` selects at least one transition, runs at least one evidence command, and every result is `confirmed` (exit 0). A successful verification emits a `state.certified` event. When that verification targets the current head, the layer also CAS-persists its latest certificate in `state/current`, so current certification survives event-window truncation.

Verification fails closed. Any of these conditions returns `certified: false` and `violated: true`: a missing current or requested target, empty evidence, a non-zero exit, a spawn error, a timeout, a cancellation, or a certification-publish failure. When the current head is the target, Fabric CAS-revokes its durable certificate first, then emits `state.violated` on a best-effort basis with every blocking reason. A publication failure cannot preserve the old current certificate. Because no durable failure event exists in that case, the report includes `reportingError`. The `violated` field remains for compatibility. Callers should use the positive check `if (!verification.certified)`. A successful result becomes durable only after `state.certified` is published.

Evidence commands are arbitrary shell commands. Treat them as legacy trusted workflow input. They run with the invoking process's authority. The state layer runs each command exactly as shell input, and it does not parse, classify, or infer meaning from its prose or output. Tests, type checks, and greps can give strong evidence for a scoped claim. Passing tests count as evidence. They do not prove the claim.

## Schema-inspired mapping

| Concept | OMP Fabric implementation |
| --- | --- |
| Editable labeled world state | Mesh key `state/current`, moved forward with compare-and-swap. |
| Append-only timeline | Mesh topic `fabric.state`. Transition and verification events stay inspectable. |
| Replayable evidence | `state.verify` runs the commands attached to each selected transition. |
| Certification | A fail-closed verification report plus a durable `state.certified` event and digests. |
| Surprise | `state.violated` logs the non-confirmed results and the blocking reasons. |
| Representation revision | A `kind: "representation"` transition sets the active history boundary. |
| Complexity reduction | Decision-point reduction needs attached evidence and stays pending until a later verification succeeds. |
| Executable goal | `state.goal({ check })` stores a predicate. `state.checkGoal()` runs it. |

The `fabric-schema` skill applies these facilities as workflow discipline while Schema mode is off. It calls the `schema.*` transaction API in audit or enforce mode. The state provider alone cannot prevent bypass. The central ActionRegistry gate supplies enforce-mode authorization.

## Storage format

The layer stores everything in the mesh. Raw mesh reads can inspect every state-layer record.

### Topic `fabric.state`

The append-only JSONL event log holds:

- **`transition`**: a versioned proposal with `data: { protocolVersion: 1, phase: "proposed", label, from?, to, summary, evidence?, tags?, kind?, complexity?, certificationStatus?, ts }`.
- **`transition.committed`**: makes its referenced proposal visible after all ledger and head CAS writes succeed.
- **`transition.rejected`**: records a failed proposal and its rollback or quarantine status. A proposal never becomes visible merely because this marker exists.
- **`state.certified`**: emitted only after a successful verification. Its data holds bounded `targets`, the verification-time `head`, `evidenceDigest`, `resultDigest`, `certificationStatus: "certified"`, and `ts`.
- **`state.violated`**: best-effort reporting for fail-closed verification. Its data holds bounded non-confirmed `results`, blocking `reasons`, selected `targets`, the verification-time `head`, and both digests.
- **`state.goal.met`**: emitted when the executable goal predicate passes.

A certificate target carries the transition's stable `transitionId`, `label`, and `to`. When verification has a head, the certificate also records that head's `transitionId`, label, destination, and CAS `version`. The fold applies certification and violation events in sequence for each target. A transition receives a certified overlay only when its latest durable verification outcome is `state.certified`. A later `state.violated` removes that overlay. Certificate currentness also requires the full recorded head identity to equal the committed current head: transition ID, label, destination, and CAS version.

After a successful verification of the current head, the layer CAS-rewrites `state/current` with the latest current certificate. The stored certificate binds to the version that this CAS produces, so persisting it does not make itself stale. If the CAS loses to head advancement, the event still certifies its target. It then comes back with `current: false`, and the layer never attaches it to the new head. A later failed verification that targets the same current head publishes `state.violated` and CAS-removes the durable certificate. A new transition replaces the whole head value, which drops the prior current certificate on its own.

Both digests use SHA-256 with a `sha256:<hex>` representation. The `evidenceDigest` covers the full ordered target identities and attached commands deterministically. The `resultDigest` deterministically covers the ordered statuses, full-output digests and byte counts, bounded prefixes, omitted-byte metadata, command and claim digests, and failures. Any byte change in command output or failure details changes the result digest, even when the returned output prefix is truncated.

Inspect the raw values with:

```ts
const events = await mesh.read({ topic: "fabric.state" });
const head = await mesh.get({ key: "state/current" });
const goal = await mesh.get({ key: "state/goal" });
```

### Key `state/current`

The compare-and-swap head holds the transition identity and claim:

```json
{
  "protocolVersion": 2,
  "commitProof": { "version": 1, "status": "committed" },
  "transitionSequence": 42,
  "label": "applied-auth-patch",
  "from": "guard-planned",
  "to": "guard-applied",
  "summary": "Refresh-token rotation now holds the lock",
  "kind": "state",
  "transitionId": "<mesh event id>",
  "ts": 1700000000000,
  "evidence": ["grep -RIn 'lock' src/auth/refresh.ts"],
  "tags": ["auth"]
}
```

The mesh entry's `version` appears as `head.version`. The layer first CAS-writes new protocol-2 heads with commit proof `{ version: 1, status: "pending" }` and the proposal's original mesh sequence. After `transition.committed` publishes, a second CAS changes the proof to `committed`. A structurally valid committed proof stays readable without the proposal or marker in the bounded mesh read window. Pending proof never becomes durable merely because events age out. The layer accepts it only while a matching commit marker stays visible, and a retained rejection marker overrides that commit marker. Existing protocol-1 heads keep their event-marker validation behavior, and older unversioned legacy heads keep their compatibility behavior.

The head stores every current transition field needed to rebuild its timeline record: original `sequence`, `label`, `from`, `to`, `summary`, `evidence`, `tags`, `kind`, `ts`, the complexity delta, and the transition-level certification status when present. If the current transition event ages out, history synthesizes only this validated current record. It never rebuilds an arbitrary non-current record from state keys.

A complexity-reduction head starts with `certificationStatus: "pending"`. The `state.get` action overlays a validated durable or retained-event certificate as `certified`. The durable certificate lives in `state/current` itself. Reads omit it when its full head binding is stale or a newer retained violation supersedes it.

### Keys `state/complexity/<file>`

Every supported file declared in a transition gets a CAS ledger entry:

```json
{
  "file": "src/auth/refresh.ts",
  "language": "typescript/javascript",
  "count": 4,
  "lastDelta": -2,
  "ts": 1700000000000
}
```

The entry holds the latest recorded observation. Baselines and deltas stay in the event log.

### Key `state/goal`

```json
{ "check": "bun typecheck && bun test", "description": "green suite" }
```

## Actions

Known actions go through the typed first-class `state.<action>(args)` proxy. Call `tools.describe({ ref: "state.<action>" })` to inspect a schema. Reserve `tools.call()` for refs computed at runtime.

### `state.transition`: risk `write`

`{ label, from?, to, summary, evidence?, tags?, kind?, complexity?: { files: string[] }, force? }`

When `from` is supplied, the provider validates it against the current committed head's `to`. It then appends a versioned proposal, CAS-writes complexity ledgers, CAS-advances `state/current` as pending, appends its commit marker, and CAS-upgrades the head's durable proof to committed. With `force: true`, the provider keeps the existing mismatch and contention override behavior. Reads, history, verification selection, and certificate targeting all ignore proposed or rejected transitions. Legacy transition events with no `phase` stay committed for compatibility.

With `complexity.files` present, the provider counts project-relative TS, JS, TSX, and JSX files immediately. The first supported observation becomes a baseline. Later observations compare against the ledger and update it. The provider reports unsupported files, and those files stay out of the ledger.

The provider rejects a negative net delta unless the transition attaches at least one non-empty behavior-preservation command. Acceptance means **evidence-attached and pending**. The transition stays uncertified at write time. The transition event and the returned head carry `certificationStatus: "pending"`. The write action never runs evidence secretly. Only a later successful `state.verify` emits a certificate. `state.history` and `state.get` can then show which reduction transition the certificate covers.

A `kind: "representation"` transition sets the history archive boundary described below.

The action returns `{ event, head }`.

### `state.get`: risk `read`

It returns `{ head, goal, complexity, certification, recentLabels }`. The `certification.current` value counts as a certificate only when its recorded head identity still equals the current head. For protocol-2 committed heads, the current head and its certified overlay survive event truncation. The `certification.recent` list holds the durable current certificate plus retained visible event certificates. Mesh event retention bounds non-current certification history.

### `state.history`: risk `read`

`{ label?, limit?, includeArchived? }` folds transitions into the ordered label graph and returns `{ transitions, labels, certifications }`. A matching committed transition exposes a certificate only when that certificate is its latest verification outcome and its `certificationStatus` is `"certified"`. A committed reduction without a latest successful outcome stays `pending`. Proposals and rejected transitions never appear. If retention removes the committed current transition event, the fold adds only the record rebuilt from a validated protocol-2 current head. It does not synthesize older non-current transitions or certificates, and mesh retention bounds them.

By default the fold finds the last representation transition and drops earlier transitions and their certificates. Setting `includeArchived: true` reveals the full append-only transition history and lets archived certificates appear. A `label` filter matches `label`, `from`, or `to` inside the selected archive view.

### `state.complexity`: risk `read`

`{ files? }` counts the requested project-relative files and compares them with the ledger. Omit `files` to inspect every recorded file. The result carries supported-language counts, current and recorded deltas, unsupported entries, and `netDelta`.

### `state.verify`: risk `execute`

`{ labels?, includeArchived?, timeoutMs? }` selects the current head when you omit `labels`. With labels supplied, it selects the active transitions that match. Archived transitions stay out unless you set `includeArchived: true`.

Commands run sequentially with a per-command timeout of 30 seconds by default. The layer streams combined stdout and stderr. It does not accumulate output without limit. Each report keeps at most a 32 KiB UTF-8 prefix per command, plus `outputBytes`, `outputOmittedBytes`, and a digest of the complete byte stream. Results also apply byte bounds to claims, commands, and errors, and each carries digest and omission metadata. Verification events use smaller bounded prefixes, bounded result and reason arrays, and target chunks, so each payload stays comfortably below the default 256 KiB mesh limit. Each result includes `{ claim, command, status, exitCode, output, outputBytes, outputOmittedBytes, outputDigest, error? }`. The `status` field is one of:

- `confirmed` on exit 0;
- `violated` on a non-zero exit;
- `error` on spawn failure, timeout, or cancellation.

The report adds `{ certified, violated, certificationStatus, evidenceDigest, resultDigest, failures, certificate? }`. The `certified` flag is true if and only if at least one evidence command ran and every result was confirmed. Any other outcome blocks certification and publishes `state.violated`. A successful run publishes `state.certified` and returns its certificate. When the selected targets include the unchanged current head, the layer then CAS-persists that certificate in `state/current` with a binding to the resulting head version. After a failed run that targets the unchanged current head, it CAS-revokes any stored certificate once violation publication succeeds.

An explicitly empty `labels` array selects nothing and fails closed. A request for an archived, proposed, rejected, or otherwise uncommitted label also fails closed as a missing active target when no committed match is visible.

On POSIX, each command shell leads a detached process group. A timeout or abort sends `SIGKILL` to that group, then waits for the shell and stdio to close before returning. Descendants in that process group receive the same signal. A descendant can escape by creating a different process group or session. On Windows, a timeout or abort awaits a bounded `taskkill /T /F` attempt and falls back to direct child termination. Windows cleanup provides best-effort coverage. Independently detached descendants can remain.

### `state.goal`: risk `write`

`{ check, description? }` saves the executable goal predicate at `state/goal`.

### `state.checkGoal`: risk `execute`

`{ timeoutMs? }` runs the goal predicate and reports `{ passed, output, exitCode, error? }`. The same 32 KiB cap bounds the command output. A passing `state.goal.met` event stores a smaller bounded prefix along with the full-stream digest and omission metadata. Goal checks stay separate from state certification.

## Complexity rule

The built-in complexity implementation handles `.ts`, `.js`, `.tsx`, and `.jsx`. It lexes tokens with no AST dependency and counts statement decision keywords:

- `if`, including the `if` in `else if`;
- `case` and `default` inside a switch body;
- `catch`, including the optional catch binding;
- `for` and `while`.

The lexer skips strings, template and JSX prose, regular-expression literals, and comments. It tokenizes `${...}` expressions and JSX expression code. Ternaries, `&&`, `||`, optional chaining, and nullish coalescing add nothing to the count. Unsupported languages return `supported: false`.

## Determinism and contention

The layer CAS-advances the head with a bounded retry loop of eight attempts. The head starts as pending, and a proposal becomes history only when its commit marker follows successful ledger and head writes. When a ledger, head, or commit-marker write fails, the layer CAS-restores each completed write from its captured before-value, or CAS-deletes a newly created value, then emits `transition.rejected` on a best-effort basis. Rejection metadata carries deleted-key versions so later CAS creation stays version-aware. Once the marker publishes, the transaction is committed and must not roll back, so the normal path performs one more CAS that keeps this fact independent of event retention. On CAS failure the layer re-reads and re-validates `from`:

- when the transition still chains from the new head, the layer retries with the new version;
- when the chain breaks, the layer raises a contention error that names the actual head.

With `force: true`, the layer skips the pre-append mismatch check and the contention re-validation. When every restoration succeeds, the rejected proposal stays invisible and the earlier ledger and head values are back in place. When restoration or rejected-marker publication fails, the thrown error reports the rollback quarantine or reporting failure explicitly. The proposal still has no commit marker, and the fold never puts it into history or verification. Certification changes the head's mesh version only when it persists or revokes the current certificate. It leaves transition sequence and archive ordering untouched.

### Crash and retention limits

- A crash before `transition.committed` leaves a pending head that fails closed. A crash after the marker is durable and before the proof-upgrade CAS leaves a pending head that the layer accepts only while that marker stays in the bounded read window. If the marker ages out first, the head fails closed and later transitions fail until an operator repairs or removes the quarantined pending value. On the normal non-crashing path, the proof upgrade happens immediately.
- Protocol-2 committed heads, their one current transition record, and their latest successfully persisted current certificate do not depend on `mesh.maxReadEvents`. Protocol-1 versioned heads still need retained commit evidence. Unversioned legacy heads keep their historical compatibility behavior.
- Non-current transitions and certificates live as event history and can age out. The state key stays small and excludes the full history.
- Certificate revocation and violation publication are two separate durable writes. Revocation goes first, so a publication failure alone cannot preserve an old current certificate. If the revocation state write fails with a non-contention storage error, the report includes `reportingError`. A successfully retained violation suppresses the old certificate while that event stays visible, and the stale durable certificate can reappear after the event ages out. A CAS loss to concurrent head advancement or a later verification is safe. The operation leaves the winning head untouched, and event order plus current binding keeps the losing result from becoming current.

## Activity

The provider emits mesh entity activity for transitions, verification runs, and goal sets, along with progress updates. These appear in the Fabric dashboard and widget.
