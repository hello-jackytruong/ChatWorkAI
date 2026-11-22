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
