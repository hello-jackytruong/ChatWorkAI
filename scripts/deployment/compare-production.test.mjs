import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const baseline = () => ({
  services: {
    builder: {
      environment: {
        ENCRYPTION_KEY: "original-key",
        DATABASE_URL: "original-db-url",
        APP_URL: "https://app.example.test",
      },
    },
    postgres: {
      environment: {
        POSTGRES_DB: "db",
        POSTGRES_USER: "user",
        POSTGRES_PASSWORD: "original-password",
      },
    },
  },
  volumes: {
    "postgres-data": { name: "existing-postgres" },
    "redis-data": { name: "existing-redis" },
  },
})
const compare = (candidate) => {
  const dir = mkdtempSync(join(tmpdir(), "chatwork-env-compare-"))
  try {
    const previous = join(dir, "previous.json")
    writeFileSync(previous, JSON.stringify(baseline()), { mode: 0o600 })
    return spawnSync(
      "python3",
      ["scripts/deployment/compare-production.py", previous],
      { input: JSON.stringify(candidate), encoding: "utf8" },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("ordinary GitHub env updates are allowed without printing configuration", () => {
  const config = baseline()
  config.services.builder.environment.APP_URL = "https://new-app.example.test"
  const result = compare(config)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "")
})
for (const key of ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"]) {
  test(`protects existing ${key} without leaking the replacement`, () => {
    const config = baseline()
    config.services.postgres.environment[key] = "replacement-private-value"
    const result = compare(config)
    assert.notEqual(result.status, 0)
    assert.ok(!result.stderr.includes("replacement-private-value"))
  })
}
for (const key of ["ENCRYPTION_KEY", "DATABASE_URL"]) {
  test(`protects existing ${key} without leaking the replacement`, () => {
    const config = baseline()
    config.services.builder.environment[key] = "replacement-private-value"
    const result = compare(config)
    assert.notEqual(result.status, 0)
    assert.ok(!result.stderr.includes("replacement-private-value"))
  })
}
for (const name of ["postgres-data", "redis-data"]) {
  test(`rejects accidental replacement of the ${name} volume`, () => {
    const config = baseline()
    config.volumes[name].name = "empty-new-volume"
    assert.notEqual(compare(config).status, 0)
  })
}
