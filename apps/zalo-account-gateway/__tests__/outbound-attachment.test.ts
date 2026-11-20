import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ assertPublicUrl: vi.fn() }))

vi.mock("@chatbotx.io/business", () => ({
  assertPublicUrl: mocks.assertPublicUrl,
}))

import { downloadOutboundAttachment } from "../src/runtime/outbound-attachment"

describe("downloadOutboundAttachment", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.assertPublicUrl.mockReset()
    mocks.assertPublicUrl.mockResolvedValue(undefined)
  })

  it("rejects an unsafe URL before downloading bytes", async () => {
    mocks.assertPublicUrl.mockRejectedValue(new Error("private address"))
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    await expect(
      downloadOutboundAttachment({
        kind: "image",
        url: "https://private.example.test/image.jpg",
      }),
    ).rejects.toThrow("private address")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("checks each redirect and returns a bounded in-memory attachment", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.redirect("https://cdn.example.test/image.jpg", 302),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-length": "3",
            "content-type": "image/jpeg",
          },
        }),
      )

    await expect(
      downloadOutboundAttachment({
        kind: "image",
        name: "safe.jpg",
        url: "https://origin.example.test/image",
      }),
    ).resolves.toMatchObject({
      filename: "safe.jpg",
      metadata: { totalSize: 3 },
    })
    expect(mocks.assertPublicUrl).toHaveBeenNthCalledWith(
      1,
      "https://origin.example.test/image",
      "Zalo Account attachment URL",
    )
    expect(mocks.assertPublicUrl).toHaveBeenNthCalledWith(
      2,
      "https://cdn.example.test/image.jpg",
      "Zalo Account attachment URL",
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("rejects MIME mismatch before an attachment reaches zca-js", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    )

    await expect(
      downloadOutboundAttachment({
        kind: "image",
        mimeType: "image/jpeg",
        url: "https://cdn.example.test/not-an-image",
      }),
    ).rejects.toThrow("MIME type does not match")
  })
})
