# Durable residency through OMP

## Purpose

Fabric participants with `residency: "durable"` continue after the originating
OMP session closes. They run in one background resident host per Fabric root.
The host owns durable actors and one-shot durable agents; mesh state and the
residency directory provide reconnection and control routing.

## Why the host starts through OMP

OMP packages intentionally leave OMP core packages as host-provided peers. A raw
Node process started from an installed Fabric package therefore cannot resolve
`@oh-my-pi/pi-coding-agent`. OMP's extension loader supplies those imports.

The resident host must consequently run inside a headless OMP process, rather
than directly under `node`.

## Process topology

```text
Fabric residency client
  -> detached Node launcher
    -> omp --mode rpc --no-session --no-tools --extension omp-entry.js
      -> OMP extension loader
        -> ResidentHost
```

`launcher.js` is Node-core-only. It keeps RPC stdin open because OMP RPC exits on
`omp-entry.js` starts `ResidentHost` on `session_start`, aborts it on
`session_shutdown`, and shuts OMP down after the host reaches its idle exit.

## Files and responsibilities

- `src/residency/client.ts` writes host configuration and starts the launcher.
- `src/residency/launcher.ts` creates the detached headless OMP child.
- `src/residency/omp-entry.ts` bridges OMP lifecycle events to the host.
- `src/residency/host.ts` owns requests, mesh control, `owner.json`, and idle
  shutdown.
- `src/index.ts` registers `residency/launcher.js`; this registration must not
  point back to `host.js`.

The residency protocol is unchanged: `config.json`, `owner.json`, request,
response, and mesh files remain the durable interface.

## Context and lifecycle

Residency does not share agent contexts. Each actor or agent retains its own
runner session. Shared work must use mesh state, files, or an explicit external
channel. Residency only keeps the execution owner available for later control
and reconnection.

The host exits after its normal idle grace once it owns no live durable actor or
running durable agent.

## Validation

Run:

```bash
bun run typecheck
bun run build
bunx vitest run tests/type-checker.test.ts tests/residency.test.ts tests/fabric-runtime-components.test.ts
```

Also validate a locally installed package in OMP: create a durable actor, verify
its `owner.json`, route `stop`, and confirm the actor becomes `stopped` with a
resident `ownerHostId`.

## Known Windows limitation

Durable residency E2E is POSIX-only today. On Windows, the launcher's spawn of
the `omp` binary through the installed `node_modules/.bin` shims hangs before
the child starts, so the resident host never starts.
The launcher, ownership observation, and protocol logic are platform-agnostic
and are tested on every operating system.

## Future direction

A native OMP extension-host subprocess API could replace `launcher.js` later.
Keep the launcher boundary isolated so that migration changes no residency
protocol or public Fabric API.
