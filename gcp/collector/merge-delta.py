"""Merge the last PC frames into the pre-staged base with the VM collector stopped."""
import argparse
import contextlib
from pathlib import Path
import sqlite3
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("state_dir", type=Path)
parser.add_argument("delta_dir", type=Path)
args = parser.parse_args()

with contextlib.closing(sqlite3.connect((args.state_dir / "venue-baselines.sqlite").resolve().as_uri() + "?mode=rw", uri=True)) as dest:
    with contextlib.closing(sqlite3.connect((args.delta_dir / "delta.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as source:
        with dest:
            dest.executemany("INSERT OR REPLACE INTO spike_price_frames_v1(slot, config, samples) VALUES (?,?,?)",
                             source.execute("SELECT slot, config, samples FROM spike_price_frames_v1 ORDER BY slot"))
            # The existing tracker prunes its restored window after its next slot.
    print("Latest baseline slot:", dest.execute("SELECT MAX(slot) FROM spike_price_frames_v1").fetchone()[0])
for name in ["factory-pools.json", "pool-registry-v1.json"]:
    data = (args.delta_dir / name).read_bytes()
    with tempfile.NamedTemporaryFile(dir=args.state_dir, delete=False) as staged:
        staged.write(data)
    Path(staged.name).replace(args.state_dir / name)
