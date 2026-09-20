#!/usr/bin/env python3
"""统计 Xiaomi MiMo / MiMoCode 本机 token 用量。

数据源：%USERPROFILE%\\.local\\share\\mimocode\\mimocode.db（message 表 tokens 字段）
用法：
  python scripts/mimo_usage.py
  python scripts/mimo_usage.py --top 15
  python scripts/mimo_usage.py --csv out\\mimo-tokens.csv
  python scripts/mimo_usage.py --sessions-csv out\\mimo-sessions.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

TZ = timezone(timedelta(hours=8))
DEFAULT_DB = Path.home() / ".local" / "share" / "mimocode" / "mimocode.db"


def parse_ts(ts) -> datetime:
    if isinstance(ts, (int, float)):
        # message.time_created 在本机为毫秒
        if ts > 1e12:
            return datetime.fromtimestamp(ts / 1000, TZ)
        return datetime.fromtimestamp(ts, TZ)
    if isinstance(ts, str):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(TZ)
        except ValueError:
            return datetime.fromtimestamp(float(ts), TZ)
    raise ValueError(f"无法解析时间: {ts!r}")


def load_messages(db_path: Path) -> list[dict]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
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

    records: list[dict] = []
    for mid, sid, ts, data, title, directory in rows:
        try:
            payload = json.loads(data)
        except (TypeError, json.JSONDecodeError):
            continue
        tokens = payload.get("tokens") or {}
        cache = tokens.get("cache") or {}
        tin = int(tokens.get("input") or 0)
        tout = int(tokens.get("output") or 0)
        reason = int(tokens.get("reasoning") or 0)
        cr = int(cache.get("read") or 0)
        cw = int(cache.get("write") or 0)
        total = int(tokens.get("total") or 0)
        if not total and any([tin, tout, reason, cr, cw]):
            total = tin + tout + reason + cr + cw
        if not total and not any([tin, tout, reason, cr, cw]):
            continue
        records.append(
            {
                "message_id": mid,
                "session_id": sid,
                "title": title or "",
                "directory": directory or "",
                "time": parse_ts(ts),
                "input": tin,
                "output": tout,
                "reasoning": reason,
                "cache_read": cr,
                "cache_write": cw,
                "total": total,
                "cost": payload.get("cost"),
            }
        )
    return records


def empty_bucket() -> dict:
    return {
        "msgs": 0,
        "input": 0,
        "output": 0,
        "reasoning": 0,
        "cache_read": 0,
        "cache_write": 0,
        "total": 0,
    }


def bump(bucket: dict, rec: dict) -> None:
    bucket["msgs"] += 1
    bucket["input"] += rec["input"]
    bucket["output"] += rec["output"]
    bucket["reasoning"] += rec["reasoning"]
    bucket["cache_read"] += rec["cache_read"]
    bucket["cache_write"] += rec["cache_write"]
    bucket["total"] += rec["total"]


def fmt(n: int) -> str:
    return f"{n:,}"


def print_table(title: str, rows: list[tuple[str, dict]]) -> None:
    print(f"\n=== {title} ===")
    if not rows:
        print("(无数据)")
        return
    name_w = max(len(label) for label, _ in rows)
    name_w = max(name_w, 8)
    header = (
        f"{'名称'.ljust(name_w)}  {'msgs':>6}  {'input':>12}  {'output':>10}  "
        f"{'cacheR':>14}  {'total':>14}"
    )
    print(header)
    print("-" * len(header))
    for label, v in rows:
        print(
            f"{label[:name_w].ljust(name_w)}  {v['msgs']:>6}  "
            f"{fmt(v['input']):>12}  {fmt(v['output']):>10}  "
            f"{fmt(v['cache_read']):>14}  {fmt(v['total']):>14}"
        )


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="统计 Xiaomi MiMo 本机 token 用量")
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help=f"mimocode.db 路径（默认 {DEFAULT_DB}）",
    )
    parser.add_argument("--top", type=int, default=10, help="按会话展示前 N 条，默认 10")
    parser.add_argument("--csv", type=Path, help="导出逐条消息 CSV")
    parser.add_argument("--sessions-csv", type=Path, help="导出按会话汇总 CSV")
    args = parser.parse_args()

    db_path: Path = args.db.expanduser()
    if not db_path.exists():
        print(f"未找到数据库: {db_path}", file=sys.stderr)
        return 1

    records = load_messages(db_path)
    if not records:
        print("库中没有 token 记录。")
        return 0

    grand = empty_bucket()
    by_day: dict[str, dict] = defaultdict(empty_bucket)
    by_session: dict[str, dict] = defaultdict(empty_bucket)
    session_meta: dict[str, tuple[str, str]] = {}

    for rec in records:
        bump(grand, rec)
        day = rec["time"].strftime("%Y-%m-%d")
        bump(by_day[day], rec)
        bump(by_session[rec["session_id"]], rec)
        session_meta[rec["session_id"]] = (rec["title"], rec["directory"])

    print(f"数据库: {db_path}")
    print("口径: total = input + output + reasoning + cache_read + cache_write（缺 total 时）")
    print(
        f"\n=== 总览 ===\n"
        f"有 token 消息: {fmt(grand['msgs'])}\n"
        f"input={fmt(grand['input'])}  output={fmt(grand['output'])}  "
        f"reasoning={fmt(grand['reasoning'])}\n"
        f"cache_read={fmt(grand['cache_read'])}  cache_write={fmt(grand['cache_write'])}\n"
        f"total={fmt(grand['total'])}\n"
        f"input+output={fmt(grand['input'] + grand['output'])}"
    )

    day_rows = [(d, by_day[d]) for d in sorted(by_day)]
    print_table("按天", day_rows)

    top_n = max(1, args.top)
    session_rows = sorted(
        ((sid, by_session[sid]) for sid in by_session),
        key=lambda item: item[1]["total"],
        reverse=True,
    )[:top_n]
    labeled = []
    for sid, v in session_rows:
        title, _ = session_meta.get(sid, ("", ""))
        label = f"{(title or '(无标题)')[:36]}  [{sid[-10:]}]"
        labeled.append((label, v))
    print_table(f"按会话 Top {top_n}", labeled)

    if args.csv:
        rows = [
            {
                "time": rec["time"].isoformat(timespec="seconds"),
                "session_id": rec["session_id"],
                "title": rec["title"],
                "directory": rec["directory"],
                "message_id": rec["message_id"],
                "input": rec["input"],
                "output": rec["output"],
                "reasoning": rec["reasoning"],
                "cache_read": rec["cache_read"],
                "cache_write": rec["cache_write"],
                "total": rec["total"],
                "cost": rec["cost"],
            }
            for rec in records
        ]
        write_csv(
            args.csv,
            rows,
            [
                "time",
                "session_id",
                "title",
                "directory",
                "message_id",
                "input",
                "output",
                "reasoning",
                "cache_read",
                "cache_write",
                "total",
                "cost",
            ],
        )
        print(f"\n已导出消息明细: {args.csv}")

    if args.sessions_csv:
        rows = []
        for sid, v in sorted(by_session.items(), key=lambda item: item[1]["total"], reverse=True):
            title, directory = session_meta.get(sid, ("", ""))
            rows.append(
                {
                    "session_id": sid,
                    "title": title,
                    "directory": directory,
                    "msgs": v["msgs"],
                    "input": v["input"],
                    "output": v["output"],
                    "reasoning": v["reasoning"],
                    "cache_read": v["cache_read"],
                    "cache_write": v["cache_write"],
                    "total": v["total"],
                }
            )
        write_csv(
            args.sessions_csv,
            rows,
            [
                "session_id",
                "title",
                "directory",
                "msgs",
                "input",
                "output",
                "reasoning",
                "cache_read",
                "cache_write",
                "total",
            ],
        )
        print(f"已导出会话汇总: {args.sessions_csv}")

    print("\n说明: 本地 cost 通常为 0；账单/配额以小米账号侧为准。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
