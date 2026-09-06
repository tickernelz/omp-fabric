#!/usr/bin/env python3
"""Paired analysis for the local DeepSWE-style loop.

Reads results/<run_id>/<config>/<task>/rep<N>/{result.json,session/*.jsonl} and
reports per-config aggregates, paired deltas, and the read-pathology metrics
from the DeepSWE trajectories issue (whole-file read share, reads over 50 KB
fabric results). Fabric cells parse per-call traces from fabric_exec result
details (details.trace.operations), which reproduces the issue's published
numbers exactly when run against the archived sessions.
"""
from __future__ import annotations

import glob
import json
import math
import os
import statistics
import sys
from collections import Counter


def load_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


def session_records(cell):
    for f in sorted(glob.glob(os.path.join(cell, "session", "*.jsonl"))):
        for line in open(f, errors="replace"):
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def content_items(rec):
    msg = rec.get("message", {})
    content = msg.get("content", [])
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict):
                yield msg, item


def read_metrics(cell, is_fabric):
    """reads, whole-file reads, per-config result sizes over 50KB."""
    reads = 0
    whole = 0
    over50 = 0
    for rec in session_records(cell):
        for msg, item in content_items(rec):
            if item.get("type") == "toolCall":
                name = item.get("name")
                args = item.get("arguments", {}) or {}
                if not is_fabric and name == "read":
                    reads += 1
                    if "offset" not in args and "limit" not in args:
                        whole += 1
            if msg.get("role") == "toolResult":
                text = "".join(
                    p.get("text", "")
                    for p in msg.get("content", [])
                    if isinstance(p, dict)
                )
                if len(text) > 50_000:
                    over50 += 1
                if is_fabric and msg.get("toolName") == "fabric_exec":
                    details = msg.get("details") or {}
                    trace = details.get("trace") or {}
                    for op in trace.get("operations", []):
                        if op.get("ref") == "omp.read":
                            reads += 1
                            a = op.get("args") or {}
                            if "offset" not in a and "limit" not in a:
                                whole += 1
    return reads, whole, over50


def collect(run_dir):
    cells = []
    for result in glob.glob(os.path.join(run_dir, "*", "*", "rep*", "result.json")):
        cell = os.path.dirname(result)
        rel = os.path.relpath(cell, run_dir)
        config, task, rep = rel.split(os.sep)
        cells.append({
            "config": config,
            "task": task,
            "rep": rep,
            "path": cell,
        })
    return cells


def exact_mcnemar(a, b):
    n = a + b
    if n == 0:
        return 1.0
    k = min(a, b)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / (2 ** n)
    return min(1.0, 2 * tail)


def median(rows, key):
    vals = [r.get(key) for r in rows if r.get(key) is not None]
    return statistics.median(vals) if vals else None


def summarize(rows):
    solved = sum(1 for r in rows if r.get("reward_binary") == 1)
    partials = [r["reward_partial"] for r in rows if r.get("reward_partial") is not None]
    out = {
        "n": len(rows),
        "solves": solved,
        "mean_partial": round(statistics.mean(partials), 4) if partials else None,
        "median_tokens": median(rows, "combined_total_tokens"),
        "median_cost": median(rows, "combined_cost_usd"),
        "median_wall_s": median(rows, "agent_wall_s"),
        "median_turns": median(rows, "turns"),
        "median_tool_calls": median(rows, "tool_calls"),
        "reads": None,
        "whole_file_reads_pct": None,
        "results_over_50kb": None,
    }
    reads = sum(r.get("reads", 0) for r in rows)
    whole = sum(r.get("whole_file_reads", 0) for r in rows)
    out["reads"] = reads
    out["whole_file_reads_pct"] = round(100.0 * whole / reads, 1) if reads else None
    out["results_over_50kb"] = sum(r.get("results_over_50kb", 0) for r in rows)
    return out


def main():
    run_dir = sys.argv[1]
    cells = collect(run_dir)
    rows = []
    for cell in cells:
        res = load_json(os.path.join(cell["path"], "result.json"))
        is_fabric = cell["config"] != "baseline"
        reads, whole, over50 = read_metrics(cell["path"], is_fabric)
        rows.append({
            **cell,
            **res,
            "reads": reads,
            "whole_file_reads": whole,
            "results_over_50kb": over50,
        })
    configs = sorted({r["config"] for r in rows})
    summary = {"run_dir": run_dir, "per_config": {}, "per_task": {}}
    for cfg in configs:
        summary["per_config"][cfg] = summarize([r for r in rows if r["config"] == cfg])
    for task in sorted({r["task"] for r in rows}):
        summary["per_task"][task] = {
            cfg: summarize([
                r for r in rows
                if r["task"] == task and r["config"] == cfg
            ])
            for cfg in configs
            if any(r["task"] == task and r["config"] == cfg for r in rows)
        }
    pairs = {}
    for r in rows:
        pairs.setdefault((r["task"], r["rep"]), {})[r["config"]] = r
    if "baseline" in configs:
        others = [c for c in configs if c != "baseline"]
        for other in others:
            paired = [
                (pv["baseline"], pv[other])
                for pv in pairs.values()
                if "baseline" in pv and other in pv
            ]
            left_only = sum(1 for a, b in paired if a.get("reward_binary") == 1 and b.get("reward_binary") != 1)
            right_only = sum(1 for a, b in paired if a.get("reward_binary") != 1 and b.get("reward_binary") == 1)
            tok_delta = [
                b["combined_total_tokens"] - a["combined_total_tokens"]
                for a, b in paired
                if a.get("combined_total_tokens") is not None and b.get("combined_total_tokens") is not None
            ]
            summary[f"paired_baseline_vs_{other}"] = {
                "n_pairs": len(paired),
                "solve_flips_left_only": left_only,
                "solve_flips_right_only": right_only,
                "mcnemar_p": round(exact_mcnemar(left_only, right_only), 4),
                "median_token_delta": statistics.median(tok_delta) if tok_delta else None,
                "mean_token_delta": round(statistics.mean(tok_delta)) if tok_delta else None,
            }
    out_path = os.path.join(run_dir, "analysis-summary.json")
    with open(out_path, "w") as fh:
        json.dump(summary, fh, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
