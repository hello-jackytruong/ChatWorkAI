"""Validate Compose's parsed environment without executing dotenv or logging secrets."""
import json
import re
import sys
from urllib.parse import urlparse

config = json.load(sys.stdin)
env = config["services"]["builder"]["environment"]


def require(condition, message):
    if not condition:
        sys.exit(message)


for key in ("BETTER_AUTH_SECRET", "REALTIME_BROADCAST_SECRET", "JAVASCRIPT_EXECUTOR_TOKEN"):
    value = env.get(key, "")
    require(len(value) >= 32 and not re.search(r"change.me|replace|placeholder", value, re.I), f"Configure a strong {key}")
require(bool(re.fullmatch(r"[a-fA-F0-9]{64}", env.get("ENCRYPTION_KEY", ""))), "ENCRYPTION_KEY must be 64 hex characters")
endpoint = urlparse(env["S3_ENDPOINT"])
require(endpoint.scheme == "https" and bool(re.fullmatch(r"[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com", endpoint.hostname or "")), "S3_ENDPOINT must be an R2 HTTPS S3 endpoint")
require(env["S3_REGION"] == "auto", "R2 region must be auto")
for key in ("APP_URL", "NEXT_PUBLIC_STORAGE_URL"):
    url = urlparse(env[key])
    require(url.scheme == "https" and bool(url.hostname) and not url.username, f"{key} must use HTTPS")
require("r2.cloudflarestorage.com" not in env["NEXT_PUBLIC_STORAGE_URL"], "Public storage must use the prefix-restricted reader, not the S3 API")
require(urlparse(env["DATABASE_URL"]).hostname == "postgres", "DATABASE_URL must target the Compose postgres service")
require(len(config["services"]["postgres"]["environment"]["POSTGRES_PASSWORD"]) >= 24, "POSTGRES_PASSWORD must have at least 24 characters")
