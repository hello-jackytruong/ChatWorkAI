import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { describe, expect, it, vi } from "vitest"

vi.mock("@chatbotx.io/filesystem", () => ({ uploader: {} }))

import {
  isPublicAddress,
  scavengeMediaTemp,
  sniffMedia,
  spoolMedia,
  validateProviderUrl,
  withMediaDeadline,
} from "../src/zalo-account-media/bounded-download"

describe("Zalo account media transport", () => {
  it.each([
    "https://127.0.0.1/a",
    "http://a.zdn.vn/a",
    "https://u:p@a.zdn.vn/a",
    "https://a.zdn.vn:444/a",
    "https://a.zdn.vn.evil.test/a",
    "https://example.com/a",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validateProviderUrl(url)).toThrow()
  })
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
    "64:ff9b::7f00:1",
  ])("rejects unsafe address %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false)
  })
  it("accepts a public pinned provider", () => {
    expect(validateProviderUrl("https://photo.zdn.vn/a").hostname).toBe(
      "photo.zdn.vn",
    )
    expect(isPublicAddress("1.1.1.1")).toBe(true)
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true)
  })
  it("spools privately and hashes actual bytes, then cleans up", async () => {
    const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex")
    const staged = await spoolMedia(
      Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
      "image",
    )
    expect(staged.mime).toBe("image/png")
    expect(staged.size).toBe(bytes.length)
    expect(staged.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect((await stat(staged.path)).mode % 0o1000).toBe(0o600)
    await staged.cleanup()
    await expect(stat(staged.path)).rejects.toThrow()
  })
  it("rejects deceptive image bytes and empty source", async () => {
    await expect(
      spoolMedia(Readable.from([Buffer.from("<html>fake</html>")]), "image"),
    ).rejects.toMatchObject({ code: "mime_mismatch" })
    await expect(spoolMedia(Readable.from([]), "file")).rejects.toMatchObject({
      code: "empty_body",
      retryable: true,
    })
  })
  it("enforces streamed byte caps without trusting a content length", async () => {
    function* bytes() {
      for (let i = 0; i < 33; i++) {
        yield Buffer.alloc(64 * 1024)
      }
    }
    await expect(
      spoolMedia(Readable.from(bytes()), "avatar"),
    ).rejects.toMatchObject({ code: "size_limit" })
  })
})

it("spools a64 MiB video with 64 KiB chunks and the exact streaming checksum", async () => {
  const first = Buffer.alloc(64 * 1024)
  first.write("ftypisom", 4, "ascii")
  const chunk = Buffer.alloc(64 * 1024, 17)
  const hash = createHash("sha256")
  function* video() {
    hash.update(first)
    yield first
    for (let i = 1; i < 1024; i++) {
      hash.update(chunk)
      yield chunk
    }
  }
  const staged = await spoolMedia(Readable.from(video()), "video")
  expect(staged.size).toBe(64 * 1024 * 1024)
  expect(staged.sha256).toBe(hash.digest("hex"))
  expect(staged.mime).toBe("video/mp4")
  await staged.cleanup()
})

it("destroys a source when aborted during a streaming spool", async () => {
  const controller = new AbortController()
  async function* body() {
    yield Buffer.from("89504e470d0a1a0a00000000", "hex")
    await Promise.resolve()
    controller.abort()
    yield Buffer.alloc(64 * 1024)
  }
  const source = Readable.from(body())
  await expect(spoolMedia(source, "image", controller.signal)).rejects.toThrow()
  expect(source.destroyed).toBe(true)
})

it.each([
  ["ffd8ff0102", "image/jpeg"],
  [Buffer.from("GIF89a").toString("hex"), "image/gif"],
  [Buffer.from("RIFF0000WEBP").toString("hex"), "image/webp"],
  [Buffer.from("0000ftypM4A ").toString("hex"), "audio/mp4"],
  [Buffer.from("OggS").toString("hex"), "audio/ogg"],
  [Buffer.from("ID3").toString("hex"), "audio/mpeg"],
  [Buffer.from("RIFF0000WAVE").toString("hex"), "audio/wav"],
  [Buffer.from("%PDF-").toString("hex"), "application/pdf"],
  ["504b03040000", "application/zip"],
])("identifies actual magic %s as %s", (hex, mime) => {
  expect(sniffMedia(Buffer.from(hex, "hex")).mime).toBe(mime)
})
it("does not trust a declared oversized or truncated source", async () => {
  const oversized = Readable.from([Buffer.from("a")])
  await expect(
    spoolMedia(oversized, "file", undefined, 26 * 1024 * 1024),
  ).rejects.toMatchObject({ code: "size_limit" })
  expect(oversized.destroyed).toBe(true)
  await expect(
    spoolMedia(Readable.from([Buffer.from("abc")]), "file", undefined, 10),
  ).rejects.toMatchObject({ code: "truncated_body", retryable: true })
})
it("scavenges only old owned directories and leaves fresh or foreign files intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "zalo-scavenge-test-"))
  try {
    const old = join(root, "chatbotx-zalo-media-old")
    await mkdir(old)
    await utimes(old, new Date(0), new Date(0))
    await mkdir(join(root, "chatbotx-zalo-media-fresh"))
    await mkdir(join(root, "foreign"))
    await writeFile(join(root, "chatbotx-zalo-media-file"), "preserve")
    expect(await scavengeMediaTemp(Date.now(), root)).toBe(1)
    expect((await readdir(root)).sort()).toEqual([
      "chatbotx-zalo-media-file",
      "chatbotx-zalo-media-fresh",
      "foreign",
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it("rejects on abort and destroys late-arriving storage streams", async () => {
  const controller = new AbortController()
  let complete!: (value: Readable) => void
  const pending = new Promise<Readable>((resolve) => {
    complete = resolve
  })
  const source = Readable.from([Buffer.from("late")])
  const task = withMediaDeadline(pending, controller.signal, (late) =>
    late.destroy(),
  )
  controller.abort(new Error("deadline"))
  await expect(task).rejects.toThrow("deadline")
  complete(source)
  await Promise.resolve()
  expect(source.destroyed).toBe(true)
  await expect(
    withMediaDeadline(
      Promise.reject(new Error("offline")),
      new AbortController().signal,
    ),
  ).rejects.toThrow("offline")
  await expect(
    withMediaDeadline(Promise.resolve(1), controller.signal),
  ).rejects.toThrow("deadline")
})
