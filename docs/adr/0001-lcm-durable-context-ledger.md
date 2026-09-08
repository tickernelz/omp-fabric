---
status: accepted
---
# LCM owns the durable context ledger

OMP Fabric's LCM engine owns a project-scoped SQLite context ledger containing every raw conversation entry indefinitely, plus immutable leaf and condensed summary nodes. The OMP session JSONL remains an integration source for on-demand selected-session reconciliation, while the LCM compaction hook reads ready frontier state and returns the standard OMP result without blocking on maintenance. This replaces the old Fabric projection directly because the required durability, hierarchy, and recovery semantics cannot be provided by the derived memory cache or by a compaction hook alone. The deterministic emergency reducer is retained inside LCM for provider outages, and the existing OMP-native engine remains an explicit delegation path.
