import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  find: vi.fn(),
  stickers: vi.fn(),
}))
vi.mock("../../zalo-account/service", () => ({
  zaloAccountService: { findByInboxId: mocks.find },
}))
vi.mock("../../zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    getStickerResourcesAndWait: mocks.stickers,
  },
}))
vi.mock("../../zalo-account-media/service", () => ({
  zaloAccountMediaService: { registerResources: mocks.register },
}))

import { captureZaloAccountMessage } from "../zalo-account-ingress"

const input = {
  channel: "zaloAccount",
  workspaceId: "1",
  inboxId: "2",
  conversationId: "3",
  messageId: "4",
  messageCreatedAt: new Date(),
  threadId: "peer",
  threadType: "user" as const,
}
describe("Zalo ingress archival boundary", () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "true")
    mocks.find.mockResolvedValue({ id: "5" })
    mocks.register.mockResolvedValue([])
  })
  it("does no lookup or write for another channel", async () => {
    await captureZaloAccountMessage({ ...input, channel: "messenger" })
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
  })
  it("does no lookup or write when disabled", async () => {
    vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "false")
    await captureZaloAccountMessage(input)
    expect(mocks.find).not.toHaveBeenCalled()
  })
  it("propagates durable registration failure so ingress cannot acknowledge lost intents", async () => {
    mocks.register.mockRejectedValue(new Error("database unavailable"))
    await expect(
      captureZaloAccountMessage({
        ...input,
        descriptors: [
          {
            kind: "image",
            role: "original",
            slot: "0",
            url: "https://a.zdn.vn/i",
          },
        ],
      }),
    ).rejects.toThrow("database unavailable")
  })
  it("bounds detail requests and keeps a missing-source record when optional sticker resolution fails", async () => {
    mocks.stickers.mockRejectedValue(new Error("offline"))
    await captureZaloAccountMessage({
      ...input,
      descriptors: [
        {
          kind: "sticker",
          role: "original",
          slot: "0",
          providerResourceId: "42",
          sourceMissing: "source_missing",
        },
      ],
    })
    expect(mocks.stickers).toHaveBeenCalledWith(
      expect.objectContaining({ stickerIds: ["42"] }),
    )
    expect(mocks.register.mock.calls[0]?.[0].resources[0]).not.toHaveProperty(
      "source",
    )
    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [expect.objectContaining({ kind: "sticker" })],
      }),
    )
  })
})
