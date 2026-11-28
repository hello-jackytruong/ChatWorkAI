import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(),
  catalog: vi.fn(),
}))

vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.findAccount },
}))

vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    getStickerCatalogAndWait: mocks.catalog,
  },
}))

import { zaloAccountStickerCatalogService } from "../src/zalo-account/sticker-catalog.service"

beforeEach(() => {
  vi.resetAllMocks()
})

it("uses the workspace-bound account's actual inbox for catalog queries", async () => {
  const stickers = [{ stickerId: "892", categoryId: "80", stickerType: 7 }]
  mocks.findAccount.mockResolvedValue({ id: "account-1", inboxId: "inbox-1" })
  mocks.catalog.mockResolvedValue(stickers)
  const query = { kind: "category" as const, categoryId: "80", limit: 20 }

  await expect(
    zaloAccountStickerCatalogService.list({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query,
    }),
  ).resolves.toEqual(stickers)
  expect(mocks.findAccount).toHaveBeenCalledWith({
    workspaceId: "workspace-1",
    id: "account-1",
  })
  expect(mocks.catalog).toHaveBeenCalledOnce()
  expect(mocks.catalog).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
      stickerCatalogQuery: query,
      waitTimeoutMs: 5000,
    }),
  )
})

it("stops a foreign account and an oversized search before accessing the provider", async () => {
  await expect(
    zaloAccountStickerCatalogService.list({
      workspaceId: "foreign-workspace",
      accountId: "account-1",
      query: { kind: "category", categoryId: "80", limit: 20 },
    }),
  ).rejects.toThrow()
  await expect(
    zaloAccountStickerCatalogService.list({
      workspaceId: "workspace-1",
      accountId: "account-1",
      query: { kind: "search", query: "a".repeat(201), limit: 21 },
    }),
  ).rejects.toThrow()
  expect(mocks.catalog).not.toHaveBeenCalled()
})
