import assert from "node:assert/strict"
import { test } from "node:test"
import reader from "./public-reader.mjs"

test("private, encoded traversal, malformed paths and writes never reach storage", async () => {
  let calls = 0
  const env = {
    MEDIA: {
      get() {
        calls++
        throw new Error("unexpected")
      },
    },
  }
  for (const path of [
    "workspace/a",
    "private/a",
    "public/%2e%2e%2fworkspace/a",
    "public/a%5cb",
    "public/%ZZ",
  ]) {
    const response = await reader.fetch(
      new Request(`https://media.test/${path}`),
      env,
    )
    assert.ok(response.status >= 400)
  }
  assert.equal(
    (
      await reader.fetch(
        new Request("https://media.test/public/a", { method: "PUT" }),
        env,
      )
    ).status,
    405,
  )
  assert.equal(calls, 0)
})

test("public objects retain metadata and video range responses", async () => {
  const response = await reader.fetch(
    new Request("https://media.test/public/a", {
      headers: { Range: "bytes=2-4" },
    }),
    {
      MEDIA: {
        get: (key, options) => {
          assert.equal(key, "public/a")
          assert.equal(options.range.get("Range"), "bytes=2-4")
          return {
            body: "abc",
            size: 10,
            range: { offset: 2, length: 3 },
            httpEtag: '"test"',
            writeHttpMetadata(h) {
              h.set("Content-Type", "video/mp4")
            },
          }
        },
      },
    },
  )
  assert.equal(response.status, 206)
  assert.equal(response.headers.get("Content-Range"), "bytes 2-4/10")
  assert.equal(await response.text(), "abc")
})

test("suffix ranges return the actual content length", async () => {
  const response = await reader.fetch(
    new Request("https://media.test/public/a", {
      headers: { Range: "bytes=-3" },
    }),
    {
      MEDIA: {
        get: () => ({
          body: "abc",
          size: 10,
          range: { suffix: 3 },
          httpEtag: '"test"',
          writeHttpMetadata(headers) {
            headers.set("Content-Type", "application/octet-stream")
          },
        }),
      },
    },
  )
  assert.equal(response.status, 206)
  assert.equal(response.headers.get("Content-Range"), "bytes 7-9/10")
  assert.equal(response.headers.get("Content-Length"), "3")
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*")
})

test("HEAD returns metadata without a body and missing objects return 404", async () => {
  const response = await reader.fetch(
    new Request("https://media.test/public/a", { method: "HEAD" }),
    {
      MEDIA: {
        head: () => ({
          size: 10,
          httpEtag: '"test"',
          writeHttpMetadata(headers) {
            headers.set("Content-Type", "application/octet-stream")
          },
        }),
      },
    },
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Content-Length"), "10")
  assert.equal(await response.text(), "")
  assert.equal(
    (
      await reader.fetch(new Request("https://media.test/public/missing"), {
        MEDIA: { get: () => null },
      })
    ).status,
    404,
  )
})
