import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const bootstrap = resolve("scripts/deployment/bootstrap.sh")

test("a fresh host clones code, updates it on the next release, and keeps credentials out of Git", () => {
  const fixture = mkdtempSync(join(tmpdir(), "chatwork-bootstrap-"))
  try {
    const source = join(fixture, "source"),
      root = join(fixture, "deployment"),
      bin = join(fixture, "bin")
    mkdirSync(join(source, "scripts/deployment"), { recursive: true })
    mkdirSync(bin)
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
    const git = (...args) =>
      execFileSync(realGit, ["-C", source, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    git("init", "-b", "dev")
    git("config", "user.name", "Deployment Test")
    git("config", "user.email", "deployment@example.test")
    writeFileSync(
      join(source, "scripts/deployment/production.sh"),
      `#!/bin/bash
set -eu
test -f "$CHATWORK_DEPLOY_ROOT/releases/$2/.env"
test "$CHATWORK_DEPLOY_LOCK_FD" = 9
python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)'
printf '%s' "$2" > "$CHATWORK_DEPLOY_ROOT/activated"
`,
    )
    writeFileSync(join(source, "version"), "one")
    writeFileSync(
      join(source, "docker-compose.production.yml"),
      "services: {}\n",
    )
    git(
      "add",
      "--",
      "version",
      "docker-compose.production.yml",
      "scripts/deployment/production.sh",
    )
    git("commit", "-m", "initial fixture")
    const first = git("rev-parse", "HEAD")
    const adapter = (name, content) => {
      writeFileSync(join(bin, name), content)
      chmodSync(join(bin, name), 0o755)
    }
    // Keep the real clone/fetch/checkout, but force its transport to a local fixture.
    adapter(
      "git",
      `#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
if 'clone' in args:
    args=[os.environ['FIXTURE_ORIGIN'] if a == 'https://github.com/owner/repo.git' else a for a in args]
    import subprocess
    result=subprocess.run([os.environ['REAL_GIT'],*args])
    if result.returncode: sys.exit(result.returncode)
    os.execv(os.environ['REAL_GIT'],[os.environ['REAL_GIT'],'-C',args[-1],'remote','set-url','origin','https://github.com/owner/repo.git'])
if 'fetch' in args:
    args=[os.environ['FIXTURE_ORIGIN'] if a == 'origin' else a for a in args]
os.execv(os.environ['REAL_GIT'],[os.environ['REAL_GIT'],*args])
`,
    )
    adapter(
      "docker",
      `#!/bin/bash
set -eu
if [[ "$1" == login ]]; then
  test "$(cat)" = fixture-github-token
fi
`,
    )
    if (process.platform === "darwin") {
      adapter(
        "flock",
        "#!/usr/bin/env python3\nimport fcntl,sys; fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)\n",
      )
    }
    const run = (sha, attempt, text) => {
      const session = join(fixture, `session-${attempt}`)
      mkdirSync(session, { mode: 0o700 })
      writeFileSync(join(session, "production.env"), text, { mode: 0o600 })
      writeFileSync(join(session, "github-token"), "fixture-github-token", {
        mode: 0o600,
      })
      writeFileSync(join(session, "migrations.sha256"), "c".repeat(64))
      return spawnSync(
        "bash",
        [
          bootstrap,
          root,
          `${sha}-10-${attempt}`,
          "owner/repo",
          "deployer",
          session,
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            REAL_GIT: realGit,
            FIXTURE_ORIGIN: `file://${source}`,
            GIT_ALLOW_PROTOCOL: "file",
          },
          encoding: "utf8",
        },
      )
    }
    let result = run(first, 1, "FIRST_SECRET=fixture-one\n")
    assert.equal(
      result.status,
      0,
      result.stderr ||
        readFileSync(join(root, `logs/bootstrap-${first}-10-1.log`), "utf8"),
    )
    assert.equal(readFileSync(join(root, "repo/version"), "utf8"), "one")
    assert.equal(
      statSync(join(root, `releases/${first}-10-1/.env`)).mode % 0o1000,
      0o600,
    )
    assert.equal(
      readFileSync(join(root, `releases/${first}-10-1/.env`), "utf8"),
      "FIRST_SECRET=fixture-one\n",
    )
    writeFileSync(join(source, "version"), "two")
    git("add", "--", "version")
    git("commit", "-m", "updated fixture")
    const second = git("rev-parse", "HEAD")
    result = run(second, 2, "SECOND_SECRET=fixture-two\n")
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(root, "repo/version"), "utf8"), "two")
    assert.equal(
      readFileSync(join(root, `releases/${second}-10-2/.env`), "utf8"),
      "SECOND_SECRET=fixture-two\n",
    )
    assert.equal(
      statSync(join(root, `releases/${first}-10-1/.env`)).mode % 0o1000,
      0o600,
    )
    assert.equal(
      readFileSync(join(root, `releases/${first}-10-1/.env`), "utf8"),
      "FIRST_SECRET=fixture-one\n",
    )
    const gitConfig = readFileSync(join(root, "repo/.git/config"), "utf8")
    assert.ok(!gitConfig.includes("fixture-github-token"))
    assert.ok(!gitConfig.includes("fixture-two"))
    assert.ok(!result.stdout.includes("fixture-two"))
    writeFileSync(join(root, "repo/version"), "manual edit")
    result = run(second, 3, "THIRD_SECRET=fixture-three\n")
    assert.notEqual(result.status, 0)
    assert.equal(
      readFileSync(join(root, "repo/version"), "utf8"),
      "manual edit",
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

const RECEIVER_LINE = /^\s*receiver='([^']+)'$/m
for (const exitStatus of [0, 1]) {
  test(`SSH receiver deletes its private env/token directory after exit ${exitStatus}`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "chatwork-receiver-"))
    try {
      writeFileSync(
        join(fixture, "bootstrap.sh"),
        '#!/bin/bash\nprintf "%s" "$5"\nexit "$EXIT_STATUS"\n',
      )
      const receiver = readFileSync(
        ".github/workflows/deploy-production.yml",
        "utf8",
      ).match(RECEIVER_LINE)?.[1]
      assert.ok(receiver)
      const input = execFileSync("tar", ["-cz", "-C", fixture, "bootstrap.sh"])
      const result = spawnSync(
        "bash",
        [
          "-c",
          receiver,
          "--",
          "/opt/chatworkai",
          "release",
          "owner/repo",
          "actor",
        ],
        {
          input,
          env: {
            ...process.env,
            TMPDIR: fixture,
            EXIT_STATUS: String(exitStatus),
          },
          encoding: "utf8",
        },
      )
      assert.equal(result.status, exitStatus, result.stderr)
      assert.equal(result.stdout[0], "/")
      assert.ok(!existsSync(result.stdout))
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
}
