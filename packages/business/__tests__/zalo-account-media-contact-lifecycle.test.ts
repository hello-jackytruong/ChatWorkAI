import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ accounts: vi.fn(), release: vi.fn() }))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountRepository: { listByWorkspace: mocks.accounts },
}))
vi.mock("../src/zalo-account-media/service", () => ({
  zaloAccountMediaService: { releaseConversationOwners: mocks.release },
}))
const { releaseZaloContactMediaReferences } = await import(
  "../src/zalo-account-media/contact-lifecycle"
)
it("releases only Zalo references inside the caller tombstone transaction without deleting bytes", async () => {
  const tx = { transaction: "parent" }
  mocks.accounts.mockResolvedValue([{ id: "account", inboxId: "inbox" }])
  mocks.release.mockResolvedValue({ released: 100, remaining: true })
  const result = await releaseZaloContactMediaReferences({
    workspaceId: "w",
    entries: [
      {
        channel: "zaloAccount",
        inboxId: "inbox",
        sourceId: "123",
        conversationIds: ["conversation"],
      },
      {
        channel: "messenger",
        inboxId: "other",
        sourceId: "foreign",
        conversationIds: ["unrelated"],
      },
    ],
    tx: tx as never,
  })
  expect(result).toEqual({ released: 100, remaining: true })
  expect(mocks.release).toHaveBeenCalledWith(
    {
      workspaceId: "w",
      accountId: "account",
      conversationIds: ["conversation"],
      contactOwnerIds: ["123"],
      limit: 100,
    },
    tx,
  )
})
it("does no lookup for other channels", async () => {
  mocks.accounts.mockClear()
  expect(
    await releaseZaloContactMediaReferences({
      workspaceId: "w",
      entries: [
        {
          channel: "messenger",
          inboxId: "i",
          sourceId: "s",
          conversationIds: [],
        },
      ],
    }),
  ).toEqual({ released: 0, remaining: false })
  expect(mocks.accounts).not.toHaveBeenCalled()
})
it("stops at the global 100-reference budget across accounts and keeps continuation", async () => {
  mocks.release.mockReset()
  mocks.accounts.mockResolvedValue([
    { id: "unrelated", inboxId: "not-owned" },
    { id: "a", inboxId: "i1" },
    { id: "b", inboxId: "i2" },
  ])
  mocks.release.mockResolvedValue({ released: 100, remaining: false })
  const entries = ["i1", "i2"].map((inboxId) => ({
    channel: "zaloAccount",
    inboxId,
    sourceId: "123",
    conversationIds: ["c"],
  }))
  expect(
    await releaseZaloContactMediaReferences({ workspaceId: "w", entries }),
  ).toEqual({ released: 100, remaining: true })
  expect(mocks.release).toHaveBeenCalledTimes(1)
})
it("bounds large pointer arrays and never releases the account-owned group profile on contact deletion", async () => {
  mocks.release.mockReset()
  mocks.accounts.mockResolvedValue([{ id: "a", inboxId: "i" }])
  mocks.release.mockResolvedValue({ released: 3, remaining: false })
  const entries = Array.from({ length: 101 }, (_, index) => ({
    channel: "zaloAccount",
    inboxId: "i",
    sourceId: `za:group:${index}`,
    conversationIds: [`c${index}`],
  }))
  expect(
    await releaseZaloContactMediaReferences({ workspaceId: "w", entries }),
  ).toEqual({ released: 3, remaining: true })
  expect(mocks.release.mock.calls[0]?.[0].conversationIds).toHaveLength(100)
  expect(mocks.release.mock.calls[0]?.[0].contactOwnerIds).toEqual([])
})
it("passes the remaining budget to the next account", async () => {
  mocks.release.mockReset()
  mocks.accounts.mockResolvedValue([
    { id: "a", inboxId: "i1" },
    { id: "b", inboxId: "i2" },
  ])
  mocks.release
    .mockResolvedValueOnce({ released: 3, remaining: false })
    .mockResolvedValueOnce({ released: 4, remaining: false })
  expect(
    await releaseZaloContactMediaReferences({
      workspaceId: "w",
      entries: ["i1", "i2"].map((inboxId) => ({
        channel: "zaloAccount",
        inboxId,
        sourceId: "123",
        conversationIds: ["c"],
      })),
    }),
  ).toEqual({ released: 7, remaining: false })
  expect(mocks.release.mock.calls[1]?.[0].limit).toBe(97)
})
