# Schema enforcement

Schema enforcement adds host authorization and a local-file transaction layer to Fabric. You opt in explicitly. The mode defaults to `off` for compatibility.

```json
{
  "schema": {
    "mode": "enforce",
    "certificateTtlMs": 30000,
    "maxFiles": 100,
    "maxBytes": 10485760,
    "trustedCommands": {
      "focused-tests": {
        "command": "bun",
        "args": ["exec", "vitest", "run", "tests/focused.test.ts"],
        "shell": false,
        "timeoutMs": 30000
      }
    }
  }
}
```

`mode` accepts `off`, `audit`, or `enforce`. An invalid value becomes `off`. Fabric clamps the certificate TTL between 1 second and 10 minutes. It limits the file count to 1 through 1,000 and transaction bytes to 1 KiB through 100 MiB. The defaults are `off`, 30 seconds, 100 files, and 10 MiB. The session locks the mode at startup, and a config reload takes effect only in the next session.

Fabric treats its global configuration as trusted host input. OMP reads a project `.omp/fabric.json` only when it marks that project trusted. A model action or an untrusted project configuration can never supply `trustedCommands`.

## Modes

- **off** leaves action authorization and tool visibility unchanged. The `schema.*` control plane stays available and does not gate other actions.
- **audit** leaves host behavior unchanged. Fabric publishes a durable `would_block` event to `fabric.schema` for every nested Fabric action or top-level OMP tool call that enforce mode would deny.
- **enforce** permits only this extension's exact, source-provenanced `fabric_exec` definition at the top level. A `tool_call` gate blocks every other built-in, external-extension, and SDK `customTools` call before execution. Fabric admits a nested call only while an owned outer invocation is active and only when its id starts with Fabric's generated `NESTED_TOOL_CALL_ID_PREFIX`, because such a call already passed registry authorization. The central resolved-action gate stays authoritative inside Fabric. Direct refs and computed `tools.call` refs share the same decision.

Under enforce mode, discovery and workflow display operations still work, along with these exact host-owned actions:

- `omp.read`, `omp.grep`, `omp.find`, `omp.ls`;
- `memory.recall`, `memory.expand`, `memory.sessions`;
- `state.get`, `state.history`, `state.complexity`;
- `mesh.self`, `mesh.read`, `mesh.members`, `mesh.get`, `mesh.list`;
- `compact.status`;
- `components.list`, `components.status`, `components.graph`;
- `schema.status`, `schema.hypothesize`, `schema.verify`, `schema.commit`, `schema.abort`.

The gate blocks `omp.edit`, `omp.write`, `omp.bash`, all agent/actor actions, mesh and state writes or execution, `compact.request`, `compact.cancel`, `components.reload`, MCP, captured extensions, and every external provider, whatever risk it declares. Enforce sessions keep declarative component entries in configuration without activating them, and registered definitions stay visible to diagnostics. A provider that claims `risk: "read"` still fails this exact-reference policy. Fabric records guard failures in the existing typed execution trace with `failureStage: "guard"`.

An enforce session never restores persistent actors, and host-event actor dispatch stays off. Fabric disables agent execution, so the gate also blocks agent actions. Capture `keepVisible`, descriptor risk, claimed source metadata, or tool visibility cannot authorize a second top-level path. Fabric blocks a colliding external or SDK tool named `fabric_exec` unless OMP's canonical `sourceInfo.path` identifies this extension's entry exactly.

## Transaction protocol

Run all steps inside one `fabric_exec` invocation. Fabric binds certificates to its `parentToolCallId`, and a later call cannot adopt them.

1. Call `schema.hypothesize` with a nonempty typed evidence set, a label, and a summary. Fabric stores a durable hypothesis bound to the current state head/version, the workspace fingerprint, the workspace generation, and the invocation.
2. Call `schema.verify`. It checks that every binding is still current, evaluates each evidence item, and fingerprints the workspace before and after the evidence runs. Missing, empty, nonconfirmed, errored, timed-out, cancelled, or workspace-changing evidence fails closed. Only a fully confirmed run issues a cryptographically random certificate bounded by the TTL.
3. Call `schema.commit`. Fabric requires both write and execute approval. The commit consumes the certificate exactly once by compare-and-swap, checks all bindings again, captures durable before images, applies the bounded declared operations sequentially, and requires a nonempty typed postcondition set. A failed operation, undeclared drift, or a failed postcondition restores every declared path. Fabric records a failed rollback as `quarantined` and a successful one as `rolled_back`.
4. Call `schema.abort` to close an uncommitted hypothesis and, when present, its certificate. Fabric also abandons active artifacts as soon as their `fabric_exec` invocation ends.

Call known Schema actions through the typed first-class proxy, and keep `tools.call()` for refs you compute at runtime:

```ts
const hypothesis = await schema.hypothesize({
  label: "update-parser",
  summary: "The parser accepts the new local form without changing existing cases",
  evidence: [
    { kind: "file_sha256", path: "src/parser.ts", sha256: "sha256:<64 hex>" },
    { kind: "trusted_command", name: "focused-tests" }
  ]
});

const verification = await schema.verify({
  hypothesisId: hypothesis.hypothesisId
});
const { certificate: _certificate, ...safeVerification } = verification;
if (!verification.verified || !verification.certificate) {
  if (verification.certificate) {
    await schema.abort({
      hypothesisId: hypothesis.hypothesisId,
      certificate: verification.certificate
    });
  }
  return { status: "failed", verification: safeVerification };
}
const parserEvidence = verification.results.find(
  (result) => result.evidence.path === "src/parser.ts",
);
if (!parserEvidence?.observedSha256) {
  await schema.abort({
    hypothesisId: hypothesis.hypothesisId,
    certificate: verification.certificate
  });
  return {
    status: "failed",
    reason: "missing observed SHA-256",
    verification: safeVerification
  };
}

const commit = await schema.commit({
  hypothesisId: hypothesis.hypothesisId,
  certificate: verification.certificate,
  operations: [{
    kind: "edit",
    path: "src/parser.ts",
    oldText: "old literal",
    newText: "new literal",
    expectedSha256: parserEvidence.observedSha256
  }],
  postconditions: [
    { kind: "file_contains", path: "src/parser.ts", literal: "new literal" },
    { kind: "trusted_command", name: "focused-tests" }
  ]
});
return { status: commit.outcome === "committed" ? "success" : "failed", commit };
```

## Evidence and preconditions

Evidence is data. The model cannot supply shell content through it. When evidence about an existing file confirms, Fabric returns the `observedSha256` measured at verification time. You can feed that hash into the commit precondition, and no shell access is involved:

- `file_exists: { path }`;
- `file_absent: { path }`;
- `file_contains: { path, literal }`, matching by literal containment;
- `file_sha256: { path, sha256 }`;
- `trusted_command: { name }`, picking a host-configured command that takes no model arguments.

Fabric never classifies command text, source text, or prose with a regex policy. SHA-256 syntax and provider/config identifiers get ordinary structural validation only.

Trusted commands belong to the trusted computing base. With `shell: false`, the default, Fabric invokes the configured executable directly with the configured static argv, and no shell interprets the line. With `shell: true`, `command` holds the complete trusted shell program. Fabric then normalizes `args` to an empty array, because escaping shell argv portably is unsound. Both forms stay trusted configuration, and the model can never supply them. Make verification commands local, deterministic, and read-only. Fabric detects workspace changes after a command runs. It cannot stop a misconfigured trusted command from causing transient or non-workspace side effects.

Commit operations run exactly and stay local:

- `write` requires `expected: { absent: true }` or `expected: { sha256 }`;
- `edit` requires `expectedSha256`, and `oldText` must occur exactly once;
- `delete` requires `expectedSha256`.

Every path must be project-relative and point at a regular file. Fabric rejects absolute paths, `..` escapes, symbolic links in any component, non-file targets, and missing parent directories. A transaction never creates directories. Before-image bytes plus write/edit payload bytes must fit `maxBytes`, and the count of distinct declared paths must fit `maxFiles`.

A hypothesis can set `complexityReduction: true`. The committed outcome reports `complexityReductionCertified: true` only after all its nonempty postconditions pass. The flag certifies those stated postconditions. Proving semantic equivalence or measuring objective complexity falls outside its scope.

## Workspace binding and durability

Inside a Git worktree, the deterministic fingerprint covers:

- the exact `HEAD` identity, or an unborn head;
- the NUL-delimited index stage listing;
- path and content/type hashes for every tracked worktree path;
- path and content/type hashes for untracked, non-ignored paths.

Fabric invokes Git with machine-oriented output and passes `-z` wherever paths appear. It never parses human `git status` prose. The session `cwd` must equal the worktree root. An unsupported tracked non-file entry, such as a submodule directory, makes the snapshot fail with an error. Outside Git, Fabric hashes eligible project files recursively under conservative file and byte bounds, and it skips dependency, build, and cache directories. Host mesh and transaction-journal storage sits outside the protected snapshot, so recording a hypothesis never invalidates itself.

Fabric stores hypotheses, certificates, gate reports, and outcomes as durable mesh records and events under `schema/*` and topic `fabric.schema`. Successful outcomes serialize through a workspace generation compare-and-swap on top of a cross-process commit lock. Before mutation, Fabric writes before images with owner-only permissions under the mesh transaction journal. On initialization, Fabric restores an `applying` journal whose owner process is gone. An unreadable or unrestorable journal stays available for operator quarantine. Fabric consumes certificates by compare-and-swap before the first file operation, so a crash can never make one reusable.

A clean commit advances the Schema generation. It also appends a normal state outcome transition on a best-effort basis. Contention over the state transition cannot falsify the already durable Schema workspace outcome.

## Exact guarantee and limitations

The host process, the filesystem, the trusted Fabric configuration, the configured trusted commands, and OMP's canonical tool lifecycle/provenance all behave as trusted components. Under that assumption, enforce mode guarantees that **only this extension's source-provenanced top-level `fabric_exec`, driving one same-invocation, fresh-certificate `schema.commit` path, can authorize model-originated mutation of regular files under the initialized local workspace**. The guarantee carries explicit preconditions, declared paths, bounded captured before images, nonempty typed postconditions, single-use compare-and-swap consumption, and rollback reporting.

The guarantee covers this defined scope:

- It excludes remote services, network calls, databases, device files, other processes, and writes performed outside Fabric. Enforce mode blocks model access to those provider channels. Its rollback guarantee covers Fabric-managed workspace files.
- No kernel sandbox protects you from a malicious extension, SDK host, or host process. Trusted host code can invoke effects without model tool calls, and it can falsify lifecycle/provenance data.
- Nested-call admission relies on OMP delivering Fabric's reserved generated id prefix unchanged, and on Fabric tracking an active owned outer invocation. Arbitrary top-level ids with that prefix still pass through the gate when no owned outer call is active.
- Trusted commands form an explicit TCB, and unsafe configuration can give them effects.
- Filesystem rollback cannot be perfectly atomic across process death or hostile concurrent writers. Journals recover declared regular files, and Fabric quarantines failures.
- File postconditions and tests supply scoped evidence only, and they do not constitute proof.
- Host metadata under the configured mesh root sits outside the protected fingerprint.
