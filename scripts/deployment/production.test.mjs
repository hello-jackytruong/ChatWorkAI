import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const UNSAFE_COMMAND = /compose.* (down|prune)/
const DIGEST = /^[0-9a-f]{64}\n$/

// Exercise the Ubuntu script on both CI and macOS. Tiny command adapters
// provide the GNU command semantics missing on a developer Mac.
for (const scenario of [
  "success",
  "no-approval-env",
  "backup-failed",
  "activation-failed",
  "revision-mismatch",
  "migration-failed",
  "unchanged-schema",
  "env-update-same-commit",
  "env-rollback",
  "credential-change",
  "fresh-seed",
  "seed-failed",
]) {
  test(`host release ordering and recovery: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "chatwork-deploy-"))
    try {
      const versioned = [
        "env-update-same-commit",
        "env-rollback",
        "credential-change",
      ].includes(scenario)
      const old =
          scenario === "env-update-same-commit"
            ? `${"b".repeat(40)}-10-1`
            : "a".repeat(40),
        sha = versioned ? `${"b".repeat(40)}-20-1` : "b".repeat(40),
        digest = "c".repeat(64)
      mkdirSync(join(root, "bin"))
      if (process.platform === "darwin") {
        const adapters = {
          stat: "import os,sys; print(oct(os.stat(sys.argv[-1]).st_mode & 0o777)[2:])",
          mv: 'import os,sys; args=[a for a in sys.argv[1:] if not a.startswith("-")]; os.replace(*args)',
          flock:
            "import fcntl,sys; fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)",
        }
        for (const [name, code] of Object.entries(adapters)) {
          const path = join(root, "bin", name)
          writeFileSync(path, `#!/usr/bin/env python3\n${code}\n`)
          chmodSync(path, 0o755)
        }
      }

      mkdirSync(join(root, "state"))
      if (scenario === "unchanged-schema") {
        writeFileSync(join(root, "state/migrations.sha256"), digest)
      }
      for (const release of [old, sha]) {
        const dir = join(root, "releases", release)
        mkdirSync(join(dir, "scripts/deployment"), { recursive: true })
        writeFileSync(
          join(dir, "docker-compose.production.yml"),
          "services: {}",
        )
        writeFileSync(join(dir, "image-prefix"), "ghcr.io/owner/chatworkai")
        writeFileSync(join(dir, "migrations.sha256"), digest)
        copyFileSync(
          "scripts/deployment/compare-production.py",
          join(dir, "scripts/deployment/compare-production.py"),
        )
        if (versioned) {
          writeFileSync(
            join(dir, ".env"),
            release === old ? "OLD_ENV=1\n" : "NEW_ENV=1\n",
            { mode: 0o600 },
          )
        }
        writeFileSync(
          join(dir, "scripts/deployment/validate-production.py"),
          "import sys\nsys.stdin.read()\n",
        )
      }
      writeFileSync(join(root, ".env"), "", { mode: 0o600 })
      if (!["fresh-seed", "seed-failed"].includes(scenario)) {
        symlinkSync(`releases/${old}`, join(root, "current"))
      }
      const config = (encryptionKey) =>
        JSON.stringify({
          services: {
            builder: {
              environment: {
                INITIAL_SEED_APPROVED: ["fresh-seed", "seed-failed"].includes(
                  scenario,
                )
                  ? "true"
                  : "false",
                ENCRYPTION_KEY: encryptionKey,
                DATABASE_URL: "same-db",
              },
            },
            postgres: {
              environment: {
                POSTGRES_DB: "db",
                POSTGRES_USER: "user",
                POSTGRES_PASSWORD: "password",
              },
            },
          },
          volumes: {
            "postgres-data": { name: "db" },
            "redis-data": { name: "redis" },
          },
        })
      const docker = join(root, "bin/docker")
      writeFileSync(
        docker,
        `#!/bin/bash
set -eu
[[ "$1" != compose || -z "\${APP_URL:-}" ]] || exit 42
printf '%s %s env=%s\\n' "$CHATWORK_RELEASE_SHA" "$*" "$CHATWORK_ENV_FILE" >> "$CHATWORK_DEPLOY_ROOT/calls"
case "$*" in
  *'config --format json'*)
    if [[ "${scenario}" == credential-change && "$CHATWORK_ENV_FILE" == *"${sha}/.env" ]]; then
      printf '%s' '${config("new-key")}'
    else
      printf '%s' '${config("old-key")}'
    fi ;;
  *'image inspect'*) echo "${scenario === "revision-mismatch" ? "wrong-revision" : "$CHATWORK_RELEASE_SHA"}" ;;
  *'builder seed'*) ${scenario === "seed-failed" ? "exit 1" : ":"} ;;
  *'builder migrate'*) ${scenario === "migration-failed" ? "exit 1" : ":"} ;;
  *'pg_dump'*) ${scenario === "backup-failed" ? "exit 1" : "echo archive"} ;;
  *'pg_restore'*) cat >/dev/null ;;
  *'up -d --no-build'*builder*) ${["activation-failed", "env-rollback"].includes(scenario) ? `[[ "$CHATWORK_RELEASE_SHA" != "${sha.slice(0, 40)}" ]]` : ":"} ;;
esac
`,
      )
      chmodSync(docker, 0o755)
      const result = spawnSync(
        "bash",
        [resolve("scripts/deployment/production.sh"), "deploy", sha],
        {
          env: {
            ...process.env,
            CHATWORK_DEPLOY_ROOT: root,
            APP_URL: "https://stale-host-export.example",
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
          },
          encoding: "utf8",
        },
      )
      const calls = readFileSync(join(root, "calls"), "utf8")
      assert.equal(
        result.status === 0,
        [
          "success",
          "no-approval-env",
          "unchanged-schema",
          "env-update-same-commit",
          "fresh-seed",
        ].includes(scenario),
        result.stderr,
      )
      if (scenario === "fresh-seed") {
        assert.ok(calls.includes("builder seed"))
        assert.ok(existsSync(join(root, "state/seeded")))
      }
      if (scenario === "seed-failed") {
        assert.ok(!existsSync(join(root, "state/seeded")))
        assert.ok(!calls.includes("up -d --no-build"))
      }
      if (scenario === "credential-change") {
        assert.ok(!calls.includes("pull "))
      }
      if (scenario === "env-update-same-commit") {
        assert.equal(readFileSync(join(root, ".env"), "utf8"), "NEW_ENV=1\n")
        assert.equal(
          readFileSync(join(root, "releases", old, ".env"), "utf8"),
          "OLD_ENV=1\n",
        )
      }
      if (scenario === "env-rollback") {
        assert.ok(calls.includes(`env=${join(root, "releases", old, ".env")}`))
        assert.equal(readFileSync(join(root, ".env"), "utf8"), "")
        assert.equal(
          readFileSync(join(root, "releases", old, ".env"), "utf8"),
          "OLD_ENV=1\n",
        )
      }
      if (scenario === "no-approval-env") {
        assert.ok(calls.includes("builder migrate"))
      }
      if (scenario === "revision-mismatch") {
        assert.ok(!calls.includes("pg_dump"))
      }
      if (scenario === "migration-failed") {
        assert.ok(!calls.includes("up -d --no-build"))
      }
      if (scenario === "unchanged-schema") {
        assert.ok(calls.includes("builder migrate"))
      }
      if (scenario === "backup-failed") {
        assert.ok(!calls.includes("builder migrate"))
      }
      if (scenario === "success") {
        assert.ok(calls.indexOf("pg_dump") < calls.indexOf("builder migrate"))
        assert.ok(
          calls.indexOf("builder migrate") < calls.indexOf("up -d --no-build"),
        )
        assert.equal(
          execFileSync("readlink", [join(root, "current")], {
            encoding: "utf8",
          }).trim(),
          `releases/${sha}`,
        )
      }
      if (scenario === "activation-failed") {
        assert.ok(calls.includes(`${old} compose`))
        assert.equal(
          execFileSync("readlink", [join(root, "current")], {
            encoding: "utf8",
          }).trim(),
          `releases/${old}`,
        )
      }
      assert.ok(!UNSAFE_COMMAND.test(calls))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("migration fingerprint is stable and covers checked-in SQL", () => {
  const first = execFileSync(
    "node",
    ["scripts/deployment/migration-digest.mjs"],
    { encoding: "utf8" },
  )
  assert.match(first, DIGEST)
  assert.equal(
    execFileSync("node", ["scripts/deployment/migration-digest.mjs"], {
      encoding: "utf8",
    }),
    first,
  )
})
