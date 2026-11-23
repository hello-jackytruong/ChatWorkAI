vi.mock("@/features/zalo-accounts/queries/use-group-message-state", () => ({
  zaloMessageStateKey: (workspaceId: string) => [
    "zalo-message-state",
    workspaceId,
  ],
}))

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  invalidate: vi.fn(),
  getState: vi.fn(),
  handlers: {} as Record<string, (event: { data: unknown }) => void>,
}))
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "workspace" }))
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}))
vi.mock("@/features/chat/store/chat-store-provider", () => ({
  useChatStore: (select: (state: unknown) => unknown) =>
    select(mocks.getState()),
}))
vi.mock("@/features/response-sla/provider/response-sla-hook", () => ({
  useResponseSlaEnabled: () => false,
}))
vi.mock("@/features/conversations/hooks/use-conversation-id-param", () => ({
  useConversationIdParam: () => ({ set: vi.fn() }),
}))
vi.mock("@/features/realtime/use-workspace-realtime-events", () => ({
  useWorkspaceRealtimeEvents: (handlers: typeof mocks.handlers) => {
    mocks.handlers = handlers
  },
}))

vi.mock("@/lib/orpc/orpc", () => ({
  client: {
    messagesAPI: { listMessagesAuthenticatedAPI: mocks.list },
    conversationsAPI: {
      findConversationAuthenticatedAPI: vi.fn(),
      listConversationsByPOSTAuthenticatedAPI: vi.fn(),
    },
  },
}))
vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { ChatRealtime } from "../src/features/chat/chat-realtime"
import { createChatStore } from "../src/features/chat/store/chat-store"

const lifecycle = {
  version: 1,
  recallId: "recall",
  lifecycleRevision: 2,
  recalled: true,
  placeholder: false,
  originalObserved: true,
  localHiddenAt: null,
  providerDeletedForMeAt: null,
}
const sourceId = "za:account:group:thread:parent"
const message = (id = "parent", overrides: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "workspace",
  conversationId: "conversation",
  contactInboxId: "inbox",
  sourceId: id === "parent" ? sourceId : `za:account:group:thread:${id}`,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  messageType: "incoming",
  senderType: "contact",
  text: "ORIGINAL_SENTINEL",
  attachments: [
    { originPath: "private/original", url: "https://provider/original" },
  ],
  contentAttributes: { zaloAccount: { group: { text: "ORIGINAL_SENTINEL" } } },
  ...overrides,
})
const setup = (rows: ReturnType<typeof message>[]) => {
  const store = createChatStore()
  store.setState({
    activeConversationId: "conversation",
    messages: rows as never,
    conversations: [
      { id: "conversation", workspaceId: "workspace", messages: [rows[0]] },
    ] as never,
  })
  return store
}
beforeEach(() => vi.clearAllMocks())
describe("Zalo retained message client fences", () => {
  it("scrubs retained original, attachments and late tracking/translation payloads", () => {
    const store = setup([message()])
    store.getState().updateMessageContentAttributes("parent", {
      zaloAccount: { sourceId, lifecycle },
    })
    store.getState().updateMessageText("parent", "ORIGINAL_SENTINEL")
    store.getState().updateMessageContentAttributes("parent", {
      zaloAccount: {
        group: {
          text: "ORIGINAL_SENTINEL",
          url: "https://provider/original",
        },
      },
    })
    store.getState().applyMessageTranslations("conversation", [
      {
        messageId: "parent",
        status: "translated",
        displayText: "ORIGINAL_SENTINEL",
      },
    ] as never)
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "provider/original",
    )
    expect(JSON.stringify(store.getState().conversations)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
  })
  it.each([
    "recall",
    "localHide",
  ])("keeps %s hidden when archived media becomes ready after the lifecycle update", (operation) => {
    const store = setup([message()])
    store.getState().updateMessageContentAttributes("parent", {
      zaloAccount: {
        sourceId,
        lifecycle: {
          ...lifecycle,
          recalled: operation === "recall",
          localHiddenAt:
            operation === "localHide" ? "2026-01-01T00:00:00Z" : null,
        },
      },
    })
    store.getState().updateMessageText("parent", "ORIGINAL_SENTINEL", {
      attachmentId: "archived",
      newAttachmentPath: null,
      newAttachmentPublicUrl: "https://storage.example/private-signed",
      newAttachmentMimeType: "image/jpeg",
      newAttachmentSize: 30,
      removedAttachment: false,
    })
    const state = store.getState()
    expect(state.messages[0]?.deletedAt).toBeUndefined()
    expect(state.messages[0]?.text).toBeNull()
    expect(state.messages[0]?.attachments).toEqual([])
    expect(JSON.stringify(state.messages)).not.toContain("ORIGINAL_SENTINEL")
    expect(JSON.stringify(state.messages)).not.toContain("private-signed")
    expect(JSON.stringify(state.conversations)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
    expect(JSON.stringify(state.conversations)).not.toContain("private-signed")
  })
  it("applies recall over newer send evidence and ignores later stale evidence", () => {
    const store = setup([
      message("parent", {
        contentAttributes: {
          zaloAccount: {
            sendAttempt: {
              status: "applied",
              reconciliation: { revision: 5, state: "needs_review" },
            },
          },
        },
      }),
    ])
    store.getState().updateMessageContentAttributes("parent", {
      zaloAccount: { sourceId, lifecycle },
    })
    store.getState().updateMessageContentAttributes("parent", {
      zaloAccount: {
        sendAttempt: {
          status: "applied",
          reconciliation: { revision: 4, state: "completed" },
        },
      },
    })
    expect(store.getState().messages[0]?.text).toBeNull()
    expect(store.getState().messages[0]?.attachments).toEqual([])
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
    expect(JSON.stringify(store.getState().conversations)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
  })
  it("scrubs loaded quotes for an off-page recalled parent while preserving reply body", () => {
    const reply = message("reply", {
      text: "reply stays",
      attachments: [
        { originPath: "reply/file", url: "https://provider/reply" },
      ],
      contentAttributes: {
        zaloAccount: {
          group: {
            quote: {
              providerMessageId: "parent",
              text: "ORIGINAL_SENTINEL",
              url: "https://provider/original",
            },
          },
        },
      },
    })
    const store = setup([reply])
    store.getState().updateMessageContentAttributes("off-page-message-id", {
      zaloAccount: { sourceId, lifecycle },
    })
    expect(store.getState().messages[0]?.text).toBe("reply stays")
    expect(store.getState().messages[0]?.attachments).toEqual([
      { originPath: "reply/file", url: "https://provider/reply" },
    ])
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "provider/original",
    )
  })
  it("keeps recalled lifecycle when an old page and a stale realtime echo arrive", async () => {
    const store = setup([message()])
    store.getState().updateMessageContentAttributes("parent", {
      zaloAccount: { sourceId, lifecycle },
    })
    store.getState().handleNewMessages([message()] as never)
    mocks.list.mockResolvedValue({ data: [message()], nextCursor: null })
    await store.getState().loadMoreMessages("workspace", 20)
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
    expect(JSON.stringify(store.getState().conversations)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
  })
  it("accepts a newly recalled marker from a duplicate page row", async () => {
    const store = setup([message()])
    mocks.list.mockResolvedValue({
      data: [
        message("parent", {
          text: null,
          attachments: [],
          contentAttributes: { zaloAccount: { lifecycle } },
        }),
      ],
      nextCursor: null,
    })
    await store.getState().loadInitialMessages("workspace", 20)
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
  })
  it("accepts a newly recalled marker from duplicate realtime without appending another row", () => {
    const store = setup([message()])
    store.getState().handleNewMessages([
      message("parent", {
        text: null,
        attachments: [],
        contentAttributes: { zaloAccount: { lifecycle } },
      }),
    ] as never)
    expect(store.getState().messages).toHaveLength(1)
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
  })
  it("projects recalled server seed before it enters the store", () => {
    const store = createChatStore({
      messagesSeed: {
        messages: [
          message("parent", {
            contentAttributes: { zaloAccount: { lifecycle } },
          }),
        ],
      },
    } as never)
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
  })
  it("keeps provider-only deletion separate and local hide monotone", () => {
    const store = setup([message()])
    store.getState().updateMessageContentAttributes("parent", {
      zaloAccount: {
        sourceId,
        lifecycle: {
          ...lifecycle,
          recalled: false,
          providerDeletedForMeAt: "2026-01-01T00:00:00Z",
        },
      },
    })
    expect(store.getState().messages[0]?.text).toBe("ORIGINAL_SENTINEL")
    store.getState().updateMessageContentAttributes("parent", {
      zaloAccount: {
        sourceId,
        lifecycle: {
          ...lifecycle,
          recalled: false,
          lifecycleRevision: 3,
          localHiddenAt: "2026-01-01T00:00:00Z",
        },
      },
    })
    store.getState().markMessagesRestored(["parent"])
    store.getState().updateMessageText("parent", "ORIGINAL_SENTINEL")
    expect(JSON.stringify(store.getState().messages)).not.toContain(
      "ORIGINAL_SENTINEL",
    )
  })
  it("retains non-Zalo content attribute replacement and message editing semantics", () => {
    const store = setup([
      message("other", {
        sourceId: "other-channel",
        contentAttributes: { old: true },
      }),
    ])
    store.getState().updateMessageContentAttributes("other", { new: true })
    store.getState().updateMessageText("other", "edited")
    expect(store.getState().messages[0]?.contentAttributes).toEqual({
      new: true,
    })
    expect(store.getState().messages[0]?.text).toBe("edited")
    expect(
      store.getState().conversations[0]?.messages[0]?.contentAttributes,
    ).toEqual({ old: true })
  })
})

it("invalidates saved content and tracking and refreshes conversation head on lifecycle realtime", async () => {
  const store = setup([message()])
  const refresh = vi.fn()
  store.setState({ scheduleConversationHeadRefresh: refresh })
  mocks.getState.mockImplementation(() => store.getState())
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(() => {
    root.render(createElement(ChatRealtime))
  })
  await act(() => {
    mocks.handlers.messageContentUpdated?.({
      data: {
        messageId: "parent",
        contentAttributes: { zaloAccount: { sourceId, lifecycle } },
      },
    })
  })
  expect(mocks.invalidate).toHaveBeenCalledWith({
    queryKey: ["zalo-message-state", "workspace"],
  })
  const saved = mocks.invalidate.mock.calls
    .map(([input]) => input)
    .find((input) => input.queryKey[0] === "zalo-saved-content")
  expect(saved.queryKey).toEqual(["zalo-saved-content", "workspace"])
  expect(
    saved.predicate({
      queryKey: [
        "zalo-saved-content",
        "workspace",
        "account",
        "conversation",
        "parent",
      ],
    }),
  ).toBe(true)
  expect(
    saved.predicate({
      queryKey: [
        "zalo-saved-content",
        "workspace",
        "account",
        "conversation",
        "other",
      ],
    }),
  ).toBe(false)
  expect(refresh).toHaveBeenCalledWith("workspace")
  await act(() => {
    root.unmount()
  })
})
