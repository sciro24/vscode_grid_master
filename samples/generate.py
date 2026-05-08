"""Generate sample data files (csv, parquet, arrow, json, jsonl) for testing Grid Master.

Run: python3 samples/generate.py
"""
import json
import random
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pyarrow.feather as feather
from pathlib import Path

random.seed(42)
OUT = Path(__file__).parent

CARRIERS = ["UA", "AA", "DL", "WN", "AS", "B6", "F9", "NK"]
ORIGINS  = ["RDU", "ORD", "JFK", "LAX", "ATL", "DFW", "SFO", "SEA", "BOS", "MIA"]
N = 500

rows = []
for i in range(N):
    delay = random.gauss(5, 25)
    rows.append({
        "fl_date": f"2024-{random.randint(1,12):02d}-{random.randint(1,28):02d}",
        "year": 2024,
        "month": random.randint(1, 12),
        "op_unique_carrier": random.choice(CARRIERS),
        "origin": random.choice(ORIGINS),
        "dest":   random.choice(ORIGINS),
        "dep_delay": round(delay, 1),
        "arr_delay": round(delay + random.gauss(0, 5), 1),
        "cancelled": random.random() < 0.02,
        "carrier_delay":  round(max(0, delay * random.random()), 1) if delay > 0 else 0,
        "weather_delay":  round(max(0, random.gauss(2, 5)), 1),
        "nas_delay":      round(max(0, random.gauss(3, 4)), 1),
        "security_delay": 0,
        "late_aircraft_delay": round(max(0, random.gauss(4, 8)), 1),
    })

df = pd.DataFrame(rows)

# CSV
df.to_csv(OUT / "flights.csv", index=False)
print(f"wrote {OUT / 'flights.csv'} ({len(df)} rows)")

# Parquet
table = pa.Table.from_pandas(df)
pq.write_table(table, OUT / "flights.parquet")
print(f"wrote {OUT / 'flights.parquet'}")

# Arrow / Feather
feather.write_feather(table, OUT / "flights.arrow")
print(f"wrote {OUT / 'flights.arrow'}")

# JSON (array of objects)
with open(OUT / "flights.json", "w") as f:
    json.dump(rows, f, indent=2)
print(f"wrote {OUT / 'flights.json'}")

# NDJSON (one object per line)
with open(OUT / "flights.jsonl", "w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
print(f"wrote {OUT / 'flights.jsonl'}")

# A small file mirroring the user's reproducer for the "2.024 year bug"
small = pd.DataFrame([{
    "fl_date": "2024-06-08",
    "year": 2024,
    "month": 6,
    "op_unique_carrier": "UA",
    "origin": "RDU",
    "dest": "ORD",
    "dep_delay": -9.0,
    "arr_delay": -6.0,
    "cancelled": 0,
    "cancellation_code": "",
    "carrier_delay": 0,
    "weather_delay": 0,
    "nas_delay": 0,
    "security_delay": 0,
    "late_aircraft_delay": 0,
}])
small.to_csv(OUT / "tiny.csv", index=False)
print(f"wrote {OUT / 'tiny.csv'}")
