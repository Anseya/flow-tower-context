# -*- coding: utf-8 -*-
"""Collect Flow Tower database statistics for the paper figures/tables."""
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(ROOT, ".flow-tower", "flow_tower.db")
OUT_DIR = os.path.join(ROOT, "paper", "data")
os.makedirs(OUT_DIR, exist_ok=True)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")


def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    out = {}

    def rows(sql, *args):
        return [dict(r) for r in cur.execute(sql, args).fetchall()]

    out["volumes"] = rows("SELECT * FROM volumes")
    counts = {}
    for table in ("entries", "archived_entries", "relations", "citations", "summary_nodes",
                  "groups", "compile_runs", "metrics", "search_terms"):
        counts[table] = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    out["counts"] = counts

    out["entries_by_kind"] = rows(
        "SELECT kind, COUNT(*) n FROM entries GROUP BY kind ORDER BY n DESC")
    out["entries_by_status"] = rows(
        "SELECT kind, status, COUNT(*) n FROM entries WHERE kind IN ('task','decision') "
        "GROUP BY kind, status ORDER BY kind, n DESC")
    out["relations_by_type"] = rows(
        "SELECT rel_type, COUNT(*) n FROM relations WHERE status='active' GROUP BY rel_type ORDER BY n DESC")
    out["top_modules"] = rows(
        "SELECT module, COUNT(*) n FROM entries WHERE module IS NOT NULL AND module != '' "
        "GROUP BY module ORDER BY n DESC LIMIT 12")

    # Entries created per 6-hour bucket x kind (for the 3D figure).
    buckets = rows(
        "SELECT (created_at/21600000)*21600000 AS bucket, kind, COUNT(*) n FROM entries "
        "GROUP BY bucket, kind ORDER BY bucket, kind")
    out["entries_buckets"] = [dict(item, time=iso(item["bucket"])) for item in buckets]

    out["compile_runs"] = [
        dict(item, at=iso(item["created_at"]),
             data=json.loads(item["data"]))
        for item in rows("SELECT * FROM metrics WHERE kind='compile' ORDER BY created_at")
    ]
    out["injections"] = [
        dict(item, at=iso(item["created_at"]), data=json.loads(item["data"]))
        for item in rows("SELECT * FROM metrics WHERE kind='digest-injection' ORDER BY created_at")
    ]
    out["maintenance"] = [
        dict(item, at=iso(item["created_at"]), data=json.loads(item["data"]))
        for item in rows("SELECT * FROM metrics WHERE kind='maintenance' ORDER BY created_at")
    ]
    usage = rows("SELECT data FROM metrics WHERE kind='usage'")
    totals = {"calls": len(usage), "inputTokens": 0, "outputTokens": 0,
              "cacheReadTokens": 0, "totalTokens": 0}
    for row in usage:
        data = json.loads(row["data"])
        for key in ("inputTokens", "outputTokens", "cacheReadTokens", "totalTokens"):
            totals[key] += int(data.get(key) or 0)
    out["usage_totals"] = totals
    out["index_meta"] = rows("SELECT * FROM index_meta")
    out["kv"] = rows("SELECT key FROM kv")

    with open(os.path.join(OUT_DIR, "stats.json"), "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)

    print("entries", counts["entries"], "relations", counts["relations"],
          "citations", counts["citations"], "nodes", counts["summary_nodes"])
    print("kinds:", [(r["kind"], r["n"]) for r in out["entries_by_kind"]])
    print("buckets:", len(out["entries_buckets"]))
    print("compile runs:", [(c["data"].get("created"), c["data"].get("updated")) for c in out["compile_runs"]])
    print("usage:", totals)
    print("saved", os.path.join(OUT_DIR, "stats.json"))


if __name__ == "__main__":
    sys.exit(main())
