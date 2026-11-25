"""Build the Linux collector or its public-market state from the existing site."""
import argparse
import contextlib
import gzip
import io
import json
from pathlib import Path
import re
import sqlite3
import tarfile
import tempfile


HERE = Path(__file__).resolve().parent
SITE = HERE.parents[1]
ENTRY = SITE / "scripts" / "public-market-monitor.mjs"
STATE = SITE / ".sites-runtime"
DIST = HERE / "dist"
IMPORT = re.compile(r"""(?:\bfrom\s+|\bimport\s*\(?\s*)['"]([^'"]+)['"]""")


def modules():
    seen = set()
    queue = [ENTRY]
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        for ref in IMPORT.findall(path.read_text(encoding="utf-8")):
            if ref.startswith("node:"):
                continue
            child = (path.parent / ref).resolve()
            if not ref.startswith(".") or not child.is_relative_to(SITE / "lib"):
                raise ValueError(f"Review new collector dependency in {path.name}: {ref}")
            if child.suffix not in {".mjs", ".js"}:
                raise ValueError(f"Unsupported module: {child.name}")
            queue.append(child)
    for path in sorted(seen):
        yield path.relative_to(SITE).as_posix(), path.read_bytes()
    yield "package.json", b'{"type":"module","private":true,"engines":{"node":">=22.13.0"}}\n'


def snapshot(staging, delta=False):
    for name in ["factory-pools.json", "pool-registry-v1.json"]:
        # Both writers replace a complete file atomically.
        data = (STATE / name).read_bytes()
        json.loads(data)
        yield name, data
    name = "venue-baselines.sqlite"
    backup = staging / name
    with contextlib.closing(sqlite3.connect((STATE / name).as_uri() + "?mode=ro", uri=True)) as live:
        with contextlib.closing(sqlite3.connect(backup)) as saved:
            if delta:
                base = int((DIST / "base-slot.txt").read_text())
                saved.execute("CREATE TABLE spike_price_frames_v1(slot INTEGER PRIMARY KEY, config TEXT NOT NULL, samples BLOB NOT NULL)")
                rows = live.execute("SELECT slot,config,samples FROM spike_price_frames_v1 WHERE slot > ? ORDER BY slot", (base,))
                saved.executemany("INSERT INTO spike_price_frames_v1 VALUES(?,?,?)", rows)
                saved.commit()
            else:
                live.backup(saved, pages=512, sleep=0.05)
            saved.execute("PRAGMA journal_mode=DELETE")
            if saved.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("SQLite backup failed integrity check")
            count, last = saved.execute("SELECT COUNT(*), MAX(slot) FROM spike_price_frames_v1").fetchone()
            print(f"Price baseline frames: {count}; latest slot: {last}")
            if not delta:
                (staging / "base-slot.txt").write_text(str(last or -1))
    yield ("delta.sqlite" if delta else name), backup.read_bytes()


def write_archive(name, entries, staging):
    tmp = staging / name
    with gzip.GzipFile(filename=tmp, mode="wb", compresslevel=3, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for member, data in entries:
                info = tarfile.TarInfo(member)
                info.size = len(data)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(data))
    dest = DIST / name
    tmp.replace(dest)
    print(f"{dest} ({dest.stat().st_size:,} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("part", nargs="?", choices=["code", "state", "delta", "all"], default="all")
    args = parser.parse_args()
    DIST.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DIST) as work:
        staging = Path(work)
        if args.part in {"code", "all"}:
            write_archive("collector.tar.gz", modules(), staging)
        if args.part in {"state", "all"}:
            write_archive("collector-state.tar.gz", snapshot(staging), staging)
            (staging / "base-slot.txt").replace(DIST / "base-slot.txt")
        if args.part == "delta":
            write_archive("collector-delta.tar.gz", snapshot(staging, delta=True), staging)
