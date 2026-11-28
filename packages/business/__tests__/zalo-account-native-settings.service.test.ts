import type { ZaloAccountNativeToolAttempt } from "@chatbotx.io/database/schema"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  context: vi.fn(),
  group: vi.fn(),
  allows: vi.fn(),
  find: vi.fn(),
  prepare: vi.fn(),
  claimDispatch: vi.fn(),
  settle: vi.fn(),
  transport: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountGroupRepository: { findByAnchor: mocks.group },
  zaloAccountSendAttemptRepository: { preparedContext: mocks.context },
  zaloAccountManagementAttemptRepository: mocks,
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/conversation/member-scope", () => ({
  conversationMemberScope: { allows: mocks.allows },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: { nativeToolAndWait: mocks.transport },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecordSafely: mocks.audit,
}))

import { zaloAccountNativeSettingsService } from "../src/zalo-account/native-settings.service"

const scope = {
  workspaceId: "10",
  accountId: "20",
  conversationId: "30",
  contactInboxId: "40",
}
const conversation = { id: "30", sourceId: null, assignedUserId: "1" }
const contactInbox = {
  id: "40",
  inboxId: "21",
  channel: "zaloAccount",
  contactKind: "person",
  sourceId: "42",
}
const account = {
  id: "20",
  inboxId: "21",
  zaloUid: "999",
  groupMessagingEnabled: false,
  groupPolicyEpoch: 3,
}
const read = { kind: "readConversationSettings" as const }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv("ZALO_ACCOUNT_CONVERSATION_SETTINGS_ACCOUNT_IDS", undefined)
  mocks.account.mockResolvedValue(account)
  mocks.context.mockResolvedValue({ conversation, contactInbox })
  mocks.allows.mockReturnValue(true)
  mocks.transport.mockResolvedValue({
    kind: read.kind,
    outcome: "confirmed",
    conversation: { pinned: true },
  })
})
afterEach(() => vi.unstubAllEnvs())

describe("Zalo Account native conversation settings", () => {
  it("rejects newly added self-profile operations on the conversation surface", async () => {
    await expect(
      zaloAccountNativeSettingsService.mutate({
        ...scope,
        operation: { kind: "updateOwnBio", bio: "Test" },
        actor: { type: "member", id: "1" },
        commandId: `${Date.now()}:f9cc28e5-7124-412c-a54c-d6871987c73e`,
      }),
    ).rejects.toThrow()
    await expect(
      zaloAccountNativeSettingsService.admit({
        ...scope,
        inboxId: account.inboxId,
        operation: { kind: "readOwnProfile" },
        thread: { threadType: "user", threadId: "42" },
        accountPolicyEpoch: 3,
        commandId: "read",
        fenceToken: "7",
      }),
    ).rejects.toThrow()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.transport).not.toHaveBeenCalled()
  })
  it("never reads the provider for a denied member or a second account with the same provider thread ID", async () => {
    mocks.allows.mockReturnValueOnce(false)
    await expect(
      zaloAccountNativeSettingsService.read({
        ...scope,
        operation: read,
        scope: { chatScope: "assigned", userId: "other", teamIds: [] },
      }),
    ).rejects.toThrow()
    mocks.account.mockResolvedValueOnce({
      ...account,
      id: "different",
      inboxId: "different",
    })
    await expect(
      zaloAccountNativeSettingsService.read({
        ...scope,
        accountId: "different",
        operation: read,
      }),
    ).rejects.toThrow()
    expect(mocks.transport).not.toHaveBeenCalled()
  })

  it("binds a group through its channelGroup anchor without requiring CRM group receive or send", async () => {
    mocks.context.mockResolvedValue({
      conversation: { ...conversation, sourceId: "za:group:42" },
      contactInbox: {
        ...contactInbox,
        contactKind: "channelGroup",
        sourceId: "za:group:42",
      },
    })
    mocks.group.mockResolvedValue({
      ...scope,
      id: "50",
      accessible: true,
      providerGroupId: "42",
      policyEpoch: 4,
      receiveEnabled: false,
      sendEnabled: false,
    })
    await expect(
      zaloAccountNativeSettingsService.read({ ...scope, operation: read }),
    ).resolves.toMatchObject({
      settings: { pinned: true },
      complete: true,
      writeEnabled: true,
    })
    expect(mocks.transport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...scope,
        inboxId: account.inboxId,
        thread: { threadType: "group", threadId: "42" },
        accountPolicyEpoch: 3,
        groupPolicyEpoch: 4,
      }),
    )
  })

  it("rejects a current-owner claim if the attempted thread type no longer binds", async () => {
    await expect(
      zaloAccountNativeSettingsService.claimDispatch({
        ...scope,
        inboxId: account.inboxId,
        operation: { kind: "setUnread", enabled: true },
        thread: { threadType: "group", threadId: "42" },
        accountPolicyEpoch: 3,
        commandId: `${Date.now()}:f9cc28e5-7124-412c-a54c-d6871987c73e`,
        fenceToken: "7",
      }),
    ).rejects.toThrow()
    expect(mocks.claimDispatch).not.toHaveBeenCalled()
  })

  it("coalesces authorized reads without caching a malformed secret-bearing snapshot", async () => {
    const promise = Promise.withResolvers<unknown>()
    mocks.transport.mockReturnValueOnce(promise.promise)
    const first = zaloAccountNativeSettingsService.read({
      ...scope,
      operation: read,
    })
    const second = zaloAccountNativeSettingsService.read({
      ...scope,
      operation: read,
    })
    await vi.waitFor(() => expect(mocks.allows).toHaveBeenCalledTimes(2))
    promise.resolve({
      kind: read.kind,
      outcome: "confirmed",
      conversation: { pinned: false, pin: "0123" },
    })
    await expect(first).resolves.toMatchObject({
      settings: {},
      complete: false,
    })
    await expect(second).resolves.toMatchObject({
      settings: {},
      complete: false,
    })
    expect(mocks.transport).toHaveBeenCalledOnce()
    await expect(
      zaloAccountNativeSettingsService.read({ ...scope, operation: read }),
    ).resolves.toMatchObject({ settings: { pinned: true } })
    expect(mocks.transport).toHaveBeenCalledTimes(2)
  })

  it("reads an uncertain native attempt after writes are disabled without writing CRM state", async () => {
    const commandId = `${Date.now()}:f9cc28e5-7124-412c-a54c-d6871987c73e`
    const operation = { kind: "setArchived" as const, enabled: true }
    let stored: ZaloAccountNativeToolAttempt | undefined
    mocks.find.mockImplementation(() => Promise.resolve(stored))
    mocks.prepare.mockImplementation(
      ({ attempt }: { attempt: ZaloAccountNativeToolAttempt }) => {
        stored = attempt
        return Promise.resolve({ status: "created", attempt })
      },
    )
    mocks.transport.mockImplementation(() => {
      if (stored) {
        stored = { ...stored, status: "unknown" }
      }
      return Promise.reject(new Error("provider reply was lost"))
    })
    const input = {
      ...scope,
      operation,
      commandId,
      actor: { type: "member" as const, id: "1" },
    }
    await expect(
      zaloAccountNativeSettingsService.mutate(input),
    ).resolves.toMatchObject({ status: "unknown" })
    await expect(
      zaloAccountNativeSettingsService.mutate(input),
    ).resolves.toMatchObject({ status: "unknown" })
    vi.stubEnv("ZALO_ACCOUNT_CONVERSATION_SETTINGS_ACCOUNT_IDS", "false")
    await expect(
      zaloAccountNativeSettingsService.attempt({ ...scope, commandId }),
    ).resolves.toMatchObject({ status: "unknown" })
    expect(mocks.transport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...scope,
        operation,
        attemptCommandId: commandId,
      }),
    )
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        attempt: expect.objectContaining({
          family: "settings",
          target: {
            conversationId: "30",
            contactInboxId: "40",
            threadId: "42",
            threadType: "user",
          },
        }),
      }),
    )
  })
})
