import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  getObjectStream: vi.fn(),
}))
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }))
vi.mock("node:https", () => ({ request: mocks.request }))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { getObjectStream: mocks.getObjectStream },
}))

import { downloadMedia } from "../src/zalo-account-media/bounded-download"

function respond(
  status = 200,
  headers: Record<string, string> = {},
  body = Buffer.from("89504e470d0a1a0a0000", "hex"),
) {
  const stream = Readable.from([body]) as Readable & {
    headers: Record<string, string>
    statusCode: number
    setTimeout: () => void
  }
  stream.statusCode = status
  stream.headers = headers
  stream.setTimeout = vi.fn()
  mocks.request.mockImplementationOnce((_url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void
      setTimeout: () => void
      destroy: () => void
    }
    req.end = () =>
      queueMicrotask(() => {
        const socket = new EventEmitter()
        req.emit("socket", socket)
        socket.emit("secureConnect")
        req.emit("response", stream)
        callback(stream)
      })
    req.setTimeout = vi.fn()
    req.destroy = vi.fn()
    // The real connection receives the previously-vetted address, without DNS again.
    const pinned = vi.fn()
    options.lookup("photo.zdn.vn", {}, pinned)
    expect(pinned).toHaveBeenCalledWith(null, "1.1.1.1", 4)
    return req
  })
  return stream
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }])
})
describe("pinned provider transport", () => {
  it("rejects a mixed public/private DNS set before connecting", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])
    await expect(
      downloadMedia({
        source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
        kind: "image",
      }),
    ).rejects.toMatchObject({ code: "unsafe_dns" })
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it("validates and destroys unsafe redirect bodies", async () => {
    const response = respond(302, { location: "https://127.0.0.1/private" })
    await expect(
      downloadMedia({
        source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
        kind: "image",
      }),
    ).rejects.toMatchObject({ code: "unsafe_url" })
    expect(response.destroyed).toBe(true)
    expect(mocks.request).toHaveBeenCalledOnce()
  })
  it("rejects compressed transfers and does not spool a deceptive content length", async () => {
    const response = respond(200, { "content-encoding": "gzip" })
    await expect(
      downloadMedia({
        source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
        kind: "image",
      }),
    ).rejects.toMatchObject({ code: "encoded_body" })
    expect(response.destroyed).toBe(true)
  })
  it("honors retryable429 and bounded Retry-After", async () => {
    respond(429, { "retry-after": "3600" })
    await expect(
      downloadMedia({
        source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
        kind: "image",
      }),
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 900_000 })
  })
  it("reads trusted storage through bounded object stream without CDN fetch", async () => {
    mocks.getObjectStream.mockResolvedValue({
      stream: Readable.from([Buffer.from("89504e470d0a1a0a0000", "hex")]),
      contentLength: 10,
    })
    const result = await downloadMedia({
      source: { type: "storage_key", key: "workspace/w/upload" },
      kind: "image",
    })
    expect(mocks.request).not.toHaveBeenCalled()
    expect(result.size).toBe(10)
    await result.cleanup()
  })
})

it("streams a public response with an exact declared length", async () => {
  respond(200, { "content-length": "10" })
  const stored = await downloadMedia({
    source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
    kind: "image",
  })
  expect(stored.size).toBe(10)
  await stored.cleanup()
})
it("repins DNS after every vetted redirect and rejects excess hops", async () => {
  for (let i = 0; i < 4; i++) {
    respond(302, { location: `https://photo.zdn.vn/${i}` })
  }
  await expect(
    downloadMedia({
      source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
      kind: "image",
    }),
  ).rejects.toMatchObject({ code: "unsafe_redirect" })
  expect(mocks.lookup).toHaveBeenCalledTimes(4)
})
it.each([
  [403, "forbidden", false],
  [404, "source_missing", false],
  [410, "source_missing", false],
  [500, "http_error", true],
])("classifies status%d truthfully", async (status, code, retryable) => {
  respond(status)
  await expect(
    downloadMedia({
      source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
      kind: "image",
    }),
  ).rejects.toMatchObject({ code, retryable })
})
it("rejects an empty DNS answer before request creation", async () => {
  mocks.lookup.mockResolvedValue([])
  await expect(
    downloadMedia({
      source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
      kind: "image",
    }),
  ).rejects.toMatchObject({ code: "unsafe_dns" })
})
it("cuts off a connection that never finishes TLS at10seconds", async () => {
  vi.useFakeTimers()
  try {
    mocks.request.mockImplementationOnce(() => {
      const req = new EventEmitter() as EventEmitter & {
        end: () => void
        setTimeout: () => void
        destroy: (error: Error) => void
      }
      req.end = () => undefined
      req.setTimeout = () => undefined
      req.destroy = (error) => {
        req.emit("error", error)
      }
      return req
    })
    const task = downloadMedia({
      source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
      kind: "image",
    })
    const rejected = expect(task).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    })
    await vi.advanceTimersByTimeAsync(10_001)
    await rejected
  } finally {
    vi.useRealTimers()
  }
})
