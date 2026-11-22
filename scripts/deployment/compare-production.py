"""Reject env changes that would strand existing data; never print values."""
import json
import sys

try:
    candidate = json.load(sys.stdin)
    with open(sys.argv[1], encoding="utf-8") as previous_file:
        previous = json.load(previous_file)
except (OSError, ValueError, KeyError):
    sys.exit("Cannot validate previous production configuration")

for key in ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"):
    old = previous["services"]["postgres"]["environment"].get(key)
    new = candidate["services"]["postgres"]["environment"].get(key)
    if old != new:
        sys.exit(f"Changing {key} requires a separate database credential/data migration")
for name in ("postgres-data", "redis-data"):
    if previous["volumes"][name]["name"] != candidate["volumes"][name]["name"]:
        sys.exit(f"Changing {name} requires an explicit data migration")
for key in ("ENCRYPTION_KEY", "DATABASE_URL"):
    old = previous["services"]["builder"]["environment"].get(key)
    new = candidate["services"]["builder"]["environment"].get(key)
    if old != new:
        sys.exit(f"Changing {key} requires a separate migration; preserve the existing value")
