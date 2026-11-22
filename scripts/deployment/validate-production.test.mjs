import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const valid = () => ({
  services: {
    builder: {
      environment: {
        APP_URL: "https://app.example.com",
        NEXT_PUBLIC_STORAGE_URL: "https://media.example.com",
        BETTER_AUTH_SECRET: "a".repeat(40),
        REALTIME_BROADCAST_SECRET: "b".repeat(40),
        JAVASCRIPT_EXECUTOR_TOKEN: "c".repeat(40),
        ENCRYPTION_KEY: "d".repeat(64),
        S3_ENDPOINT: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
        S3_REGION: "auto",
        DATABASE_URL: "postgresql://user:password@postgres:5432/db",
      },
    },
    postgres: { environment: { POSTGRES_PASSWORD: "e".repeat(32) } },
  },
})
const run = (config) =>
  spawnSync("python3", ["scripts/deployment/validate-production.py"], {
    input: JSON.stringify(config),
    encoding: "utf8",
  })
test("valid R2 production configuration is accepted without printing secrets", () => {
  const result = run(valid())
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, "")
})
for (const [key, value] of [
  ["S3_ENDPOINT", "http://filesystem:9000"],
  ["ENCRYPTION_KEY", "invalid"],
  ["DATABASE_URL", "postgresql://user:password@localhost/db"],
  ["BETTER_AUTH_SECRET", "change-me"],
]) {
  test(`rejects invalid ${key} without printing its value`, () => {
    const config = valid()
    config.services.builder.environment[key] = value
    const result = run(config)
    assert.notEqual(result.status, 0)
    assert.ok(!result.stderr.includes(value))
  })
}
