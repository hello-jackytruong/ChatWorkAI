import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  binding: vi.fn(),
  page: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountSendAttemptRepository: { preparedContext: mocks.binding },
}))
vi.mock("../src/message/list-for-conversation", () => ({
  listForConversation: mocks.page,
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))

const { zaloAccountTimelineService } = await import(
  "../src/zalo-account/timeline.service"
)
const scope = {
  workspaceId: "w",
  accountId: "a",
  contactInboxId: "ci",
  conversationId: "c",
}
const date = new Date("2026-11-28T03:00:00.000Z")

describe("Zalo conversation media and quote search", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.account.mockResolvedValue({ inboxId: "i" })
    mocks.binding.mockResolvedValue({
      contactInbox: {
        channel: "zaloAccount",
        contactKind: "person",
        sourceId: "u",
      },
    })
  })

  it("filters a bounded page within the current account and keeps the next cursor", async () => {
    const link = {
      id: "11",
      text: "Báo giá",
      sourceId: "za:a:user:u:11",
      attachments: [],
      contentAttributes: {
        zaloAccount: {
          richContent: { kind: "link", url: "https://example.com" },
        },
      },
    }
    const recalled = {
      ...link,
      id: "12",
      sourceId: "za:a:user:u:12",
      contentAttributes: { zaloAccount: { lifecycle: { recalled: true } } },
    }
    mocks.page.mockResolvedValueOnce({
      data: [
        link,
        recalled,
        { ...link, id: "13", sourceId: "za:other:user:u:13" },
      ],
      nextCursor: { id: "next", createdAt: date },
    })
    await expect(
      zaloAccountTimelineService.search({
        ...scope,
        kind: "link",
        query: "báo",
      }),
    ).resolves.toEqual({
      data: [link],
      nextCursor: { id: "next", createdAt: date },
    })
    expect(mocks.page).toHaveBeenCalledTimes(1)
    expect(mocks.page).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w",
        conversationId: "c",
        contactInboxId: "ci",
      }),
    )
  })

  it("does not query rows if the account does not own the selected Inbox", async () => {
    mocks.binding.mockResolvedValueOnce(null)
    await expect(
      zaloAccountTimelineService.search({ ...scope, kind: "file" }),
    ).rejects.toThrow()
    expect(mocks.page).not.toHaveBeenCalled()
  })

  it("returns only the requested provider message from the bounded quote page", async () => {
    const original = { id: "11", sourceId: "za:a:user:u:11", attachments: [] }
    mocks.page.mockResolvedValueOnce({
      data: [{ ...original, sourceId: "za:a:user:other:11" }, original],
      nextCursor: null,
    })
    await expect(
      zaloAccountTimelineService.locate({
        ...scope,
        providerMessageId: "11",
        timestampMs: date.getTime(),
      }),
    ).resolves.toEqual(original)
    expect(mocks.page).toHaveBeenCalledTimes(1)
  })
})
