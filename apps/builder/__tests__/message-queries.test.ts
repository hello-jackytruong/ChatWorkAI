import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  translations: vi.fn(),
  listForConversation: vi.fn(),
  findByIdWithUrls: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  messageService: {
    listForConversation: mocks.listForConversation,
    findByIdWithUrls: mocks.findByIdWithUrls,
  },
}))

vi.mock("@/features/translation/lib/message-translations", () => ({
  withMessageTranslations: mocks.translations,
}))

const { findMessage, listMessages } = await import(
  "../src/features/messages/queries"
)

describe("message queries adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.translations.mockImplementation(async (_workspaceId, data) => data)
    mocks.listForConversation.mockResolvedValue({ data: [], nextCursor: null })
    mocks.findByIdWithUrls.mockResolvedValue({
      id: "msg-1",
      workspaceId: "ws-1",
      conversationId: "conv-1",
      attachments: [],
    })
  })

  test("findMessage delegates to messageService without resolving a session", async () => {
    // A workspace-token request has no better-auth session — see
    // public-list-queries-no-session.test.ts.
    const createdAt = new Date("2026-06-01T00:00:00Z")

    await findMessage({ id: "msg-1", workspaceId: "ws-1", createdAt })

    expect(mocks.findByIdWithUrls).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      id: "msg-1",
      createdAt,
    })
  })

  test("listMessages delegates the request as-is when no cursor is given", async () => {
    await listMessages({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      perPage: 20,
    })

    expect(mocks.listForConversation).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      contactInboxId: undefined,
      cursor: undefined,
      limit: 20,
    })
  })

  test("listMessages returns null cursors when the service reports no next page", async () => {
    const result = await listMessages({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      perPage: 20,
    })

    expect(result.nextCursor).toBeNull()
    expect(result.prevCursor).toBeNull()
  })
})

test("translation enrichment cannot restore retained Zalo originals in list or detail", async () => {
  const marked = {
    id: "m",
    sourceId: "za:1:user:2:3",
    conversationId: "conv-1",
    workspaceId: "ws-1",
    text: null,
    attachments: [],
    contentAttributes: { zaloAccount: { lifecycle: { recalled: true } } },
  }
  mocks.listForConversation.mockResolvedValue({
    data: [marked],
    nextCursor: null,
  })
  mocks.findByIdWithUrls.mockResolvedValue(marked)
  mocks.translations.mockImplementation(async (_workspaceId, data) =>
    data.map((row: object) => ({
      ...row,
      translation: { displayText: "translated-original-secret" },
      text: "restored-original-secret",
    })),
  )
  const list = await listMessages(
    { workspaceId: "ws-1", conversationId: "conv-1", perPage: 20 },
    { includeTranslation: true },
  )
  const detail = await findMessage(
    { workspaceId: "ws-1", id: "m", createdAt: new Date() },
    { includeTranslation: true },
  )
  expect(JSON.stringify([list, detail])).not.toContain("original-secret")
})
