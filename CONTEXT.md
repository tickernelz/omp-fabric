# OMP Fabric Context

OMP Fabric is an OMP extension that manages durable coding-session context, tool execution, and recovery across compaction and session-tree changes.

## Context and Compaction

**Context ledger**:
The durable, ordered record of raw conversation entries owned by the LCM engine.
_Avoid_: memory cache, summary log

**Raw entry**:
One lossless conversation record in the context ledger, retaining its session, branch, parent, role, timestamp, and content identity.
_Avoid_: snippet, projection

**Summary node**:
An immutable LCM record that compresses a bounded source range or completed child nodes while retaining exact lineage.
_Avoid_: flat summary, digest

**Leaf summary**:
A summary node whose sources are raw entries from one bounded contiguous range.
_Avoid_: first-level digest

**Condensed summary**:
A summary node whose sources are completed summary nodes at a lower depth.
_Avoid_: merged snippet

**Summary frontier**:
The ready set of highest-value summary nodes selected for the next model-visible context assembly.
_Avoid_: latest summaries

**Fresh tail**:
The newest raw entries protected from summary replacement so the active task remains operationally coherent.
_Avoid_: recent cache

**Source lineage**:
The session, branch, entry-range, parent links, and source hash that prove where a raw entry or summary node came from.
_Avoid_: provenance text

**Emergency reducer**:
The deterministic LCM path that keeps the active context bounded when model-backed maintenance cannot produce a ready summary.
_Avoid_: Fabric fallback

**LCM engine**:
The replacement context engine that owns the context ledger, summary DAG, frontier assembly, and exact recovery surface.
_Avoid_: optional compaction mode
