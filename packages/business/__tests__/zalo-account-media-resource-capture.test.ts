import { beforeEach, expect, it, vi } from "vitest"

const register = vi.hoisted(() => vi.fn())
vi.mock("../src/zalo-account-media/service", () => ({
  zaloAccountMediaService: { registerResources: register },
}))

import { captureZaloAccountResourceMedia } from "../src/zalo-account-media/resource-capture"

beforeEach(() => {
  vi.resetAllMocks()
  register.mockResolvedValue([])
  vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "true")
})
it("captures only supplied consumed profile sources and absent sources never erase an avatar", async () => {
  await captureZaloAccountResourceMedia({
    workspaceId: "1",
    accountId: "2",
    resources: [
      {
        ownerKind: "account",
        ownerId: "2",
        avatarUrl: "https://cdn.example/avatar",
        coverUrl: "https://cdn.example/cover",
      },
      { ownerKind: "group", ownerId: "g", avatarUrl: null },
    ],
  })
  expect(register).toHaveBeenCalledOnce()
  expect(register.mock.calls[0][0].resources).toEqual([
    expect.objectContaining({
      ownerKind: "account",
      ownerId: "2",
      role: "avatar",
      source: { type: "provider_url", url: "https://cdn.example/avatar" },
    }),
  ])
})
it("has no side effects while disabled", async () => {
  vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "false")
  await captureZaloAccountResourceMedia({
    workspaceId: "1",
    accountId: "2",
    resources: [
      {
        ownerKind: "account",
        ownerId: "2",
        avatarUrl: "https://cdn.example/avatar",
      },
    ],
  })
  expect(register).not.toHaveBeenCalled()
})
