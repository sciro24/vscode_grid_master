"""Generate sample data files for testing Grid Master.

Run: python3 samples/generate.py
Requires: pip3 install pandas pyarrow openpyxl fastavro pyorc
"""
import json
import random
import sqlite3
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pyarrow.feather as feather
import fastavro
import pyorc
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

# Arrow / Feather — no compression so apache-arrow JS can read it without codecs
feather.write_feather(table, OUT / "flights.arrow", compression="uncompressed")
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

# TSV (tab-separated values)
df.to_csv(OUT / "flights.tsv", index=False, sep='\t')
print(f"wrote {OUT / 'flights.tsv'} ({len(df)} rows)")

# XLSX (Excel)
df.to_excel(OUT / "flights.xlsx", index=False, engine="openpyxl")
print(f"wrote {OUT / 'flights.xlsx'} ({len(df)} rows)")

# XLSB — true binary xlsb requires proprietary tooling; openpyxl writes xlsx-compatible
# content regardless of extension. SheetJS (used by the extension) reads it correctly.
df.to_excel(OUT / "flights.xlsb", index=False, engine="openpyxl")
print(f"wrote {OUT / 'flights.xlsb'} (xlsx content, .xlsb extension for format testing)")

# Avro
avro_schema = {
    "type": "record",
    "name": "Flight",
    "fields": [
        {"name": "fl_date",            "type": "string"},
        {"name": "year",               "type": "int"},
        {"name": "month",              "type": "int"},
        {"name": "op_unique_carrier",  "type": "string"},
        {"name": "origin",             "type": "string"},
        {"name": "dest",               "type": "string"},
        {"name": "dep_delay",          "type": "double"},
        {"name": "arr_delay",          "type": "double"},
        {"name": "cancelled",          "type": "boolean"},
        {"name": "carrier_delay",      "type": "double"},
        {"name": "weather_delay",      "type": "double"},
        {"name": "nas_delay",          "type": "double"},
        {"name": "security_delay",     "type": "double"},
        {"name": "late_aircraft_delay","type": "double"},
    ]
}
parsed_schema = fastavro.parse_schema(avro_schema)
avro_rows = [
    {**r, "cancelled": bool(r["cancelled"]),
           "security_delay": float(r["security_delay"])}
    for r in rows
]
with open(OUT / "flights.avro", "wb") as f:
    fastavro.writer(f, parsed_schema, avro_rows)
print(f"wrote {OUT / 'flights.avro'} ({len(avro_rows)} rows)")

# SQLite
sqlite_path = OUT / "flights.db"
sqlite_path.unlink(missing_ok=True)
con = sqlite3.connect(sqlite_path)
df.to_sql("flights", con, index=False, if_exists="replace")
# add a second table for multi-table testing
carriers_df = pd.DataFrame({"code": list(set(r["op_unique_carrier"] for r in rows))})
carriers_df.to_sql("carriers", con, index=False, if_exists="replace")
con.close()
print(f"wrote {OUT / 'flights.db'} (tables: flights, carriers)")

# ORC
orc_path = OUT / "flights.orc"
orc_schema = "struct<fl_date:string,year:int,month:int,op_unique_carrier:string,origin:string,dest:string,dep_delay:double,arr_delay:double,cancelled:boolean,carrier_delay:double,weather_delay:double,nas_delay:double,security_delay:double,late_aircraft_delay:double>"
with open(orc_path, "wb") as f:
    with pyorc.Writer(f, orc_schema) as writer:
        for r in rows:
            writer.write((
                r["fl_date"], r["year"], r["month"],
                r["op_unique_carrier"], r["origin"], r["dest"],
                r["dep_delay"], r["arr_delay"], bool(r["cancelled"]),
                r["carrier_delay"], r["weather_delay"], r["nas_delay"],
                float(r["security_delay"]), r["late_aircraft_delay"],
            ))
print(f"wrote {OUT / 'flights.orc'} ({len(rows)} rows)")

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
