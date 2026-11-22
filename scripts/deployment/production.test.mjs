import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync,
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
  "unapproved",
  "backup-failed",
  "activation-failed",
  "revision-mismatch",
  "migration-failed",
  "unchanged-schema",
]) {
  test(`host release ordering and recovery: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "chatwork-deploy-"))
    try {
      const old = "a".repeat(40),
        sha = "b".repeat(40),
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
        writeFileSync(
          join(dir, "scripts/deployment/validate-production.py"),
          "import sys\nsys.stdin.read()\n",
        )
      }
      writeFileSync(join(root, ".env"), "", { mode: 0o600 })
      symlinkSync(`releases/${old}`, join(root, "current"))
      const docker = join(root, "bin/docker")
      writeFileSync(
        docker,
        `#!/bin/bash
set -eu
printf '%s %s\\n' "$CHATWORK_RELEASE_SHA" "$*" >> "$CHATWORK_DEPLOY_ROOT/calls"
case "$*" in
  *'config --format json'*) printf '%s' '{"services":{"builder":{"environment":{"APPROVED_MIGRATION_DIGEST":"${["unapproved", "unchanged-schema"].includes(scenario) ? "" : digest}"}}}}' ;;
  *'image inspect'*) echo "${scenario === "revision-mismatch" ? "wrong-revision" : "$CHATWORK_RELEASE_SHA"}" ;;
  *'builder migrate'*) ${scenario === "migration-failed" ? "exit 1" : ":"} ;;
  *'pg_dump'*) ${scenario === "backup-failed" ? "exit 1" : "echo archive"} ;;
  *'pg_restore'*) cat >/dev/null ;;
  *'up -d --no-build'*builder*) ${scenario === "activation-failed" ? `[[ "$CHATWORK_RELEASE_SHA" != "${sha}" ]]` : ":"} ;;
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
            PATH: `${join(root, "bin")}:${process.env.PATH}`,
          },
          encoding: "utf8",
        },
      )
      const calls = readFileSync(join(root, "calls"), "utf8")
      assert.equal(
        result.status === 0,
        ["success", "unchanged-schema"].includes(scenario),
        result.stderr,
      )
      if (scenario === "unapproved") {
        assert.ok(!calls.includes("pull "))
      }
      if (scenario === "revision-mismatch") {
        assert.ok(!calls.includes("pg_dump"))
      }
      if (scenario === "migration-failed") {
        assert.ok(!calls.includes("up -d --no-build"))
      }
      if (scenario === "unchanged-schema") {
        assert.ok(!calls.includes("builder migrate"))
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
