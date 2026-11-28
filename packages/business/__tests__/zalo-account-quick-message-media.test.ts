import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  register: vi.fn(),
  sign: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountMediaRepository: { list: mocks.list },
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { getPresignedDownload: mocks.sign },
}))
vi.mock("../src/logger", () => ({ logger: { warn: vi.fn() } }))
vi.mock("../src/zalo-account-media/service", () => ({
  zaloAccountMediaService: { registerResources: mocks.register },
}))

import { resolveQuickMessageMedia } from "../src/zalo-account-media/quick-message-media"

const scope = { workspaceId: "10", accountId: "20" }
const original = "https://media.zadn.vn/example/single.png?ref=temporary"
const item = { id: 123, keyword: "demo", title: "Example", hasMedia: true }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "true")
  mocks.list.mockResolvedValue([])
})

test("serves the provider URL and archives one item revision in the exact account", async () => {
  const items = [{ ...item, media: { url: original, photoId: "1234" } }]
  await expect(resolveQuickMessageMedia(scope, items)).resolves.toEqual(items)
  expect(mocks.register).toHaveBeenCalledWith({
    ...scope,
    resources: [
      expect.objectContaining({
        ownerKind: "quickMessage",
        ownerId: "123",
        role: "original",
        source: { type: "provider_url", url: original },
      }),
    ],
  })
  const first = mocks.register.mock.calls[0]?.[0].resources[0].sourceRevision
  await resolveQuickMessageMedia(scope, [
    {
      ...item,
      title: "Another title",
      media: { url: original.replace("temporary", "renewed"), photoId: "1234" },
    },
  ])
  expect(mocks.register.mock.calls[1]?.[0].resources[0].sourceRevision).toBe(
    first,
  )
})

test("prefers signed stored media for the same revision and suppresses unsafe preview URLs", async () => {
  await resolveQuickMessageMedia(scope, [{ ...item, media: { url: original } }])
  const sourceRevision =
    mocks.register.mock.calls[0]?.[0].resources[0].sourceRevision
  mocks.register.mockClear()
  mocks.list.mockResolvedValue([
    {
      reference: { ownerId: "123", role: "original", sourceRevision },
      asset: {
        state: "stored",
        deletionPhase: "active",
        objectKey: "workspace/10/zalo-account/20/image.png",
      },
    },
  ])
  mocks.sign.mockResolvedValue("https://example.com/signed")
  const result = await resolveQuickMessageMedia(scope, [
    { ...item, media: { url: original } },
    { ...item, id: 999, media: { url: "https://zadn.vn.example.com/unsafe" } },
  ])
  expect(result[0]?.media?.url).toBe("https://example.com/signed")
  expect(result[1]).toEqual({ ...item, id: 999, media: undefined })
  expect(mocks.register).not.toHaveBeenCalled()
})
