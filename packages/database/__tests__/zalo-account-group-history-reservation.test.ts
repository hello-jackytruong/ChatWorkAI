import { beforeEach, expect, it, vi } from "vitest"
import { MessageShardUnavailableError } from "../src/errors"

const m = vi.hoisted(() => ({
  payload: {} as Record<string, unknown>,
  writes: vi.fn(),
  findMessage: vi.fn(),
  remove: vi.fn(),
  replayed: false,
  select: vi.fn(),
}))

vi.mock("../src/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client")>()),
  db: {
    transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      await work({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => ({ for: () => m.select() }),
            }),
          }),
        }),
        execute: vi.fn(),
        query: {
          conversationModel: {
            findFirst: async () => ({ id: "c", contactId: "p" }),
          },
          contactInboxModel: { findFirst: async () => ({ id: "ci" }) },
        },
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            m.payload = values
            return { onConflictDoUpdate: async () => undefined }
          },
        }),
        delete: () => ({ where: m.remove }),
      }),
  },
}))
vi.mock("../src/repositories/message", () => ({
  createMessageRepository: async () => ({
    createWithStableIdentity: m.writes,
    findById: m.findMessage,
  }),
}))
vi.mock("../src/repositories/workspace", () => ({
  workspaceRepository: { lockWorkspaceForChildWrite: async () => true },
}))
vi.mock(
  "../src/repositories/integration-zalo-account/message-recall-repository",
  () => ({
    lockZaloAccountMessageTarget: async () => undefined,
    zaloAccountMessageRecallRepository: { findTarget: async () => null },
  }),
)
vi.mock(
  "../src/repositories/integration-zalo-account/send-attempt-repository",
  () => ({
    zaloAccountSendAttemptRepository: {},
  }),
)

const { zaloAccountGroupInboxRepository } = await import(
  "../src/repositories/integration-zalo-account/group-inbox-repository"
)
const input = {
  workspaceId: "w",
  accountId: "a",
  inboxId: "i",
  groupId: "g",
  contactInboxId: "ci",
  conversationId: "c",
  accountPolicyEpoch: 1,
  groupPolicyEpoch: 2,
  history: true as const,
  message: {
    threadType: "group" as const,
    threadId: "provider-group",
    providerMessageId: "42",
    senderId: "21",
    timestampMs: Date.parse("2020-01-01T00:00:00Z"),
    msgType: "webchat",
    isSelf: false,
    text: "Backdated message",
    attachments: [],
    mentions: [],
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  m.replayed = false
  m.findMessage.mockResolvedValue(null)
  const account = { groupMessagingEnabled: true, groupPolicyEpoch: 1 }
  const group = {
    receiveEnabled: true,
    accessible: true,
    policyEpoch: 2,
    contactInboxId: "ci",
    conversationId: "c",
  }
  m.select
    .mockResolvedValueOnce([account])
    .mockResolvedValueOnce([group])
    .mockResolvedValueOnce([account])
    .mockResolvedValueOnce([group])
    .mockImplementationOnce(async () => [
      m.replayed
        ? {
            ...m.payload,
            payload: { historyImported: true, historyReplayed: true },
          }
        : m.payload,
    ])
})

it("releases a fresh quiet reservation if no primary could begin the shard write", async () => {
  const { ZaloAccountMessageIdentityRangeUnavailableError } = await import(
    "../src/errors"
  )
  m.writes.mockRejectedValue(
    new ZaloAccountMessageIdentityRangeUnavailableError(),
  )
  await expect(
    zaloAccountGroupInboxRepository.persist(input),
  ).resolves.toMatchObject({
    isNew: false,
    historyResult: "skipped",
  })
  expect(m.remove).toHaveBeenCalledOnce()
})

it("keeps the reservation when a shard write could have begun", async () => {
  m.writes.mockRejectedValue(
    new MessageShardUnavailableError("Shard response was lost"),
  )
  await expect(zaloAccountGroupInboxRepository.persist(input)).rejects.toThrow(
    "Shard response was lost",
  )
  expect(m.remove).not.toHaveBeenCalled()
})

it("keeps a replayed reservation even when the current attempt has no primary", async () => {
  const { ZaloAccountMessageIdentityRangeUnavailableError } = await import(
    "../src/errors"
  )
  m.replayed = true
  m.writes.mockRejectedValue(
    new ZaloAccountMessageIdentityRangeUnavailableError(),
  )
  await expect(zaloAccountGroupInboxRepository.persist(input)).rejects.toThrow(
    "No registered primary",
  )
  expect(m.remove).not.toHaveBeenCalled()
})
