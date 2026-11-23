import { Readable } from "node:stream"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue({}),
  endpoint: "https://account.r2.cloudflarestorage.com",
}))
vi.mock("../src/keys", () => ({
  keys: () => ({
    get S3_ENDPOINT() {
      return mocks.endpoint
    },
    S3_REGION: "auto",
    S3_BUCKET: "media",
    S3_ACCESS_KEY_ID: "test-key",
    S3_SECRET_ACCESS_KEY: "test-secret",
  }),
}))

import { Uploader } from "../src/lib/uploader"

describe("R2 upload compatibility", () => {
  beforeEach(() => mocks.send.mockClear())

  test("omits object ACLs on R2 and preserves metadata and body", async () => {
    mocks.endpoint = "https://account.r2.cloudflarestorage.com"
    const storage = new Uploader()
    vi.spyOn(storage.client, "send").mockImplementation(mocks.send)
    await storage.putObject("public/image", "bytes", {
      ACL: "public-read",
      ContentType: "image/jpg",
      ContentLength: 5,
    })
    expect(mocks.send.mock.calls[0][0].input).toEqual({
      Bucket: "media",
      Key: "public/image",
      Body: "bytes",
      ContentType: "image/jpeg",
      ContentLength: 5,
    })
  })

  test("forwards an optional abort signal for bounded archival reads and listing", async () => {
    const storage = new Uploader()
    vi.spyOn(storage.client, "send").mockImplementation(mocks.send)
    const signal = new AbortController().signal
    await storage.headObject("workspace/1/zalo-account/2/object", {
      abortSignal: signal,
    })
    expect(mocks.send.mock.calls[0][1]).toEqual({ abortSignal: signal })
    await storage.listObjects(
      "workspace/1/zalo-account/2/",
      { MaxKeys: 100 },
      { abortSignal: signal },
    )
    expect(mocks.send.mock.calls[1][1]).toEqual({ abortSignal: signal })
    expect(mocks.send.mock.calls[1][0].input.MaxKeys).toBe(100)
  })

  test("forwards a signal while opening a trusted uploaded-object stream", async () => {
    const storage = new Uploader()
    const body = Readable.from(["bytes"])
    vi.spyOn(storage.client, "send").mockImplementation(mocks.send)
    mocks.send.mockResolvedValueOnce({ Body: body, ContentLength: 5 })
    const signal = new AbortController().signal
    const result = await storage.getObjectStream("public/space/1/upload", {
      abortSignal: signal,
    })
    expect(mocks.send.mock.calls[0][1]).toEqual({ abortSignal: signal })
    expect(result.stream).toBe(body)
    body.destroy()
  })

  test("forwards a deletion deadline without changing ordinary deletion calls", async () => {
    const storage = new Uploader()
    vi.spyOn(storage.client, "send").mockImplementation(mocks.send)
    const signal = new AbortController().signal
    await storage.deleteObject("workspace/1/zalo-account/2/object", {
      abortSignal: signal,
    })
    expect(mocks.send.mock.calls[0][1]).toEqual({ abortSignal: signal })
  })

  test("preserves S3 and RustFS ACL behavior", async () => {
    mocks.endpoint = "http://localhost:9000"
    const storage = new Uploader()
    vi.spyOn(storage.client, "send").mockImplementation(mocks.send)
    await storage.putObject("public/image", "bytes", {
      ACL: "public-read",
    })
    expect(mocks.send.mock.calls[0][0].input.ACL).toBe("public-read")
  })

  test("does not treat an unrelated host containing the R2 name as R2", async () => {
    mocks.endpoint = "https://account.r2.cloudflarestorage.com.example.org"
    const storage = new Uploader()
    vi.spyOn(storage.client, "send").mockImplementation(mocks.send)
    await storage.putObject("image", "bytes", { ACL: "private" })
    expect(mocks.send.mock.calls[0][0].input.ACL).toBe("private")
  })
})
