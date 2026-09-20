#!/usr/bin/env python3
"""汇总 Xiaomi MiMo / MiMoCode 本地 token 用量，并导出 CSV。

数据源：~/.local/share/mimocode/mimocode.db 的 message 表（每条助手消息的 tokens 字段）。
金额本地恒为 0；配额/账单以小米账号侧为准。缓存读会计入 total，通常计费更便宜。

用法：
  python scripts/mimo-usage.py
  python scripts/mimo-usage.py --out reports
  python scripts/mimo-usage.py --db "D:\\path\\to\\mimocode.db"
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

TZ = timezone(timedelta(hours=8))

DEFAULT_DB = Path.home() / ".local" / "share" / "mimocode" / "mimocode.db"
ONETRACK = Path.home() / "AppData" / "Roaming" / "Xiaomi MiMo" / "onetrack-queue.jsonl"


def _ts_to_dt(ts) -> datetime:
    if ts is None:
        return datetime.fromtimestamp(0, TZ)
    if isinstance(ts, str):
        # SQLite ISO or numeric-as-string
        try:
            return datetime.fromtimestamp(float(ts) / 1000 if float(ts) > 1e12 else float(ts), TZ)
        except ValueError:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(TZ)
    n = float(ts)
    # ms vs s heuristic
    return datetime.fromtimestamp(n / 1000 if n > 1e12 else n, TZ)


def load_messages(db: Path) -> list[dict]:
    if not db.is_file():
        raise FileNotFoundError(f"找不到数据库: {db}")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        rows = cur.execute(
            """
            SELECT m.id, m.session_id, m.time_created, m.data, s.title, s.directory
            FROM message m
            LEFT JOIN session s ON s.id = m.session_id
            ORDER BY m.time_created ASC
            """
        ).fetchall()
    finally:
        con.close()

    out: list[dict] = []
    for mid, sid, ts, data, title, directory in rows:
        try:
            d = json.loads(data or "{}")
        except json.JSONDecodeError:
            continue
        tokens = d.get("tokens") or {}
        if not isinstance(tokens, dict):
            continue
        cache = tokens.get("cache") or {}
        if not isinstance(cache, dict):
            cache = {}
        tin = int(tokens.get("input") or 0)
        tout = int(tokens.get("output") or 0)
        reason = int(tokens.get("reasoning") or 0)
        cr = int(cache.get("read") or 0)
        cw = int(cache.get("write") or 0)
        total = int(tokens.get("total") or 0)
        if not total and any((tin, tout, reason, cr, cw)):
            total = tin + tout + reason + cr + cw
        if not any((tin, tout, reason, cr, cw, total)):
            continue
        dt = _ts_to_dt(ts)
        out.append(
            {
                "message_id": mid,
                "session_id": sid,
                "title": title or "",
                "directory": directory or "",
                "time": dt,
                "day": dt.strftime("%Y-%m-%d"),
                "input": tin,
                "output": tout,
                "reasoning": reason,
                "cache_read": cr,
                "cache_write": cw,
                "total": total,
                "cost": float(d.get("cost") or 0),
                "role": d.get("role") or "",
            }
        )
    return out


def load_onetrack(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    out: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            h = (o.get("data") or {}).get("H") or {}
            if h.get("event") != "model_call":
                continue
            b = (o.get("data") or {}).get("B") or {}
            t = o.get("t") or 0
            dt = datetime.fromtimestamp(t / 1000, TZ) if t else datetime.fromtimestamp(0, TZ)
            out.append(
                {
                    "time": dt,
                    "day": dt.strftime("%Y-%m-%d"),
                    "session_id": b.get("sessionID") or "",
                    "model_id": b.get("model_id") or "",
                    "provider": b.get("provider") or "",
                    "tokens_in": int(b.get("total_tokens_in") or 0),
                    "tokens_out": int(b.get("total_tokens_out") or 0),
                    "cached_read": int(b.get("cached_read_tokens") or 0),
                    "latency_ms": b.get("latency_ms"),
                    "ttft_ms": b.get("ttft_ms"),
                }
            )
    return out


def _blank() -> dict:
    return {
        "messages": 0,
        "input": 0,
        "output": 0,
        "reasoning": 0,
        "cache_read": 0,
        "cache_write": 0,
        "total": 0,
        "cost": 0.0,
    }


def _add(bucket: dict, row: dict) -> None:
    bucket["messages"] += 1
    for k in ("input", "output", "reasoning", "cache_read", "cache_write", "total"):
        bucket[k] += row[k]
    bucket["cost"] += row.get("cost") or 0.0


def aggregate(messages: list[dict]) -> tuple[dict, dict, dict]:
    grand = _blank()
    by_day: dict[str, dict] = defaultdict(_blank)
    by_session: dict[str, dict] = defaultdict(
        lambda: {**_blank(), "title": "", "directory": ""}
    )
    for row in messages:
        _add(grand, row)
        _add(by_day[row["day"]], row)
        sess = by_session[row["session_id"]]
        _add(sess, row)
        sess["title"] = row["title"] or sess["title"]
        sess["directory"] = row["directory"] or sess["directory"]
    return grand, by_day, by_session


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def fmt_n(n: float) -> str:
    return f"{int(n):,}"


def print_summary(grand: dict, by_day: dict, by_session: dict) -> None:
    print("=== 汇总（message.tokens）===")
    print(
        f"消息数: {fmt_n(grand['messages'])}\n"
        f"input={fmt_n(grand['input'])}  output={fmt_n(grand['output'])}  "
        f"reasoning={fmt_n(grand['reasoning'])}\n"
        f"cache_read={fmt_n(grand['cache_read'])}  cache_write={fmt_n(grand['cache_write'])}\n"
        f"total={fmt_n(grand['total'])}  (input+output={fmt_n(grand['input']+grand['output'])})"
    )
    print("\n=== 按天 ===")
    for day in sorted(by_day):
        v = by_day[day]
        print(
            f"{day}: msgs={v['messages']} in={fmt_n(v['input'])} out={fmt_n(v['output'])} "
            f"cacheR={fmt_n(v['cache_read'])} total={fmt_n(v['total'])}"
        )
    print("\n=== 按会话 Top 10 ===")
    top = sorted(by_session.items(), key=lambda x: -x[1]["total"])[:10]
    for sid, v in top:
        title = (v["title"] or "(无标题)")[:36]
        print(
            f"{sid}  {title}\n"
            f"  msgs={v['messages']} in={fmt_n(v['input'])} out={fmt_n(v['output'])} "
            f"cacheR={fmt_n(v['cache_read'])} total={fmt_n(v['total'])}"
        )
    print("\n说明: 本地 cost 多为 0；total 含 cache_read，实际计费请对账号账单。")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="导出 Xiaomi MiMo 本地 token 用量")
    p.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"mimocode.db 路径（默认 {DEFAULT_DB}）")
    p.add_argument("--out", type=Path, default=None, help="CSV 输出目录；不传则只打印不写文件")
    p.add_argument("--onetack", action="store_true", help="同时汇总 onetrack-queue.jsonl 近期 model_call")
    p.add_argument("--quiet", action="store_true", help="不打印摘要")
    args = p.parse_args(argv)

    try:
        messages = load_messages(args.db)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        return 1

    grand, by_day, by_session = aggregate(messages)
    if not args.quiet:
        print_summary(grand, by_day, by_session)

    if args.out:
        out: Path = args.out
        write_csv(
            out / "mimo_usage_by_day.csv",
            ["day", "messages", "input", "output", "reasoning", "cache_read", "cache_write", "total", "cost"],
            [
                {"day": day, **by_day[day]}
                for day in sorted(by_day)
            ],
        )
        write_csv(
            out / "mimo_usage_by_session.csv",
            ["session_id", "title", "directory", "messages", "input", "output", "reasoning",
             "cache_read", "cache_write", "total", "cost"],
            [
                {"session_id": sid, **v}
                for sid, v in sorted(by_session.items(), key=lambda x: -x[1]["total"])
            ],
        )
        write_csv(
            out / "mimo_usage_messages.csv",
            ["time", "day", "session_id", "title", "message_id", "role", "input", "output",
             "reasoning", "cache_read", "cache_write", "total", "cost"],
            [
                {**r, "time": r["time"].isoformat(timespec="seconds")}
                for r in messages
            ],
        )
        if not args.quiet:
            print(f"\n已写出:\n  {out / 'mimo_usage_by_day.csv'}\n  {out / 'mimo_usage_by_session.csv'}\n  {out / 'mimo_usage_messages.csv'}")

    if args.onetack:
        calls = load_onetrack(ONETRACK)
        tin = sum(c["tokens_in"] for c in calls)
        tout = sum(c["tokens_out"] for c in calls)
        cr = sum(c["cached_read"] for c in calls)
        print("\n=== onetrack model_call（队列内，非全历史）===")
        print(f"calls={len(calls)} in={fmt_n(tin)} out={fmt_n(tout)} cacheR={fmt_n(cr)}")
        by_model: dict[str, dict] = defaultdict(lambda: {"calls": 0, "in": 0, "out": 0, "cache": 0})
        for c in calls:
            m = by_model[c["model_id"] or "unknown"]
            m["calls"] += 1
            m["in"] += c["tokens_in"]
            m["out"] += c["tokens_out"]
            m["cache"] += c["cached_read"]
        for mid, v in sorted(by_model.items(), key=lambda x: -(x[1]["in"] + x[1]["out"])):
            print(f"{mid}: calls={v['calls']} in={fmt_n(v['in'])} out={fmt_n(v['out'])} cacheR={fmt_n(v['cache'])}")
        if args.out:
            write_csv(
                args.out / "mimo_usage_onetrack.csv",
                ["time", "day", "session_id", "model_id", "provider", "tokens_in", "tokens_out", "cached_read", "latency_ms", "ttft_ms"],
                [
                    {**c, "time": c["time"].isoformat(timespec="seconds")}
                    for c in calls
                ],
            )
            if not args.quiet:
                print(f"  {args.out / 'mimo_usage_onetrack.csv'}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
