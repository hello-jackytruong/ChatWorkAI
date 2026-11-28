import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
  resolveAccount: vi.fn(),
  directTarget: vi.fn(),
  importSelected: vi.fn(),
  contactCounterUserIds: vi.fn(),
  incrementImportedContacts: vi.fn(),
  recoverFriendCaches: vi.fn(),
  findOrCreateConversation: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock("@chatbotx.io/redis", () => ({
  cacheConnections: {
    useExisting: () =>
      Promise.resolve({ get: mocks.get, set: mocks.set, eval: mocks.eval }),
  },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountFriendImportRepository: { importSelected: mocks.importSelected },
  zaloAccountSendAttemptRepository: { directTarget: mocks.directTarget },
}))
vi.mock("../src/quota-enforcement/service", () => ({
  quotaEnforcementService: {
    contactCounterUserIds: mocks.contactCounterUserIds,
    incrementImportedContacts: mocks.incrementImportedContacts,
  },
}))
vi.mock("../src/zalo-account/friend-sync.service", () => ({
  zaloAccountFriendSyncService: { recoverCaches: mocks.recoverFriendCaches },
}))
vi.mock("../src/conversation/service", () => ({
  conversationService: { findOrCreate: mocks.findOrCreateConversation },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.resolveAccount },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    contactOperationAndWait: mocks.dispatch,
  },
}))
vi.mock("../src/zalo-account/friend-activity.service", () => ({
  zaloAccountFriendActivityService: { listIncoming: vi.fn() },
}))

import { zaloAccountContactOperationsService as service } from "../src/zalo-account/contact-operations.service"

const scope = { workspaceId: "1", accountId: "2" }
const peer = "1001"
const redisValues = new Map<string, string>()
const applied = (contactsResult: object) => ({
  status: "applied",
  result: { status: "applied", contactsResult },
})

beforeEach(() => {
  redisValues.clear()
  vi.resetAllMocks()
  vi.stubEnv("ZALO_ACCOUNT_CONTACT_OPERATIONS_ACCOUNT_IDS", "2,3")
  mocks.get.mockImplementation((key) =>
    Promise.resolve(redisValues.get(key) ?? null),
  )
  mocks.set.mockImplementation((key, value, _unit, _ms, nx) => {
    if (nx && redisValues.has(key)) {
      return Promise.resolve(null)
    }
    redisValues.set(key, value)
    return Promise.resolve("OK")
  })
  mocks.eval.mockImplementation((_, _n, key, ...args) => {
    if (args.length > 1 && redisValues.get(key) === args[0]) {
      redisValues.set(key, args[1])
    }
    return Promise.resolve(1)
  })
  mocks.resolveAccount.mockImplementation(({ id }) =>
    Promise.resolve({ id, inboxId: `inbox-${id}`, zaloUid: "999" }),
  )
  mocks.directTarget.mockResolvedValue({
    id: "4",
    contactId: "5",
    channel: "zaloAccount",
  })
  mocks.findOrCreateConversation.mockResolvedValue({ id: "6" })
  mocks.contactCounterUserIds.mockResolvedValue(["owner", "tenant-owner"])
  mocks.incrementImportedContacts.mockResolvedValue(undefined)
  mocks.recoverFriendCaches.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("Zalo Account contact operations", () => {
  it("quietly imports an explicitly selected new UID and accounts for it once", async () => {
    const tx = { transaction: "contact import" }
    mocks.directTarget.mockResolvedValueOnce(null)
    mocks.dispatch.mockResolvedValue(
      applied({ contacts: [{ uid: peer, name: "Customer" }] }),
    )
    mocks.importSelected.mockImplementation(async (_input, quota) => {
      const userIds = await quota.userIdsForOwner("owner")
      await quota.countContact(tx, userIds)
      return { id: "4", contactId: "5", created: true }
    })
    const lookup = await service.lookup({
      ...scope,
      commandId: "lookup",
      operation: { kind: "lookupUsername", username: "known" },
    })
    const selected = lookup.contacts[0]
    if (!selected) {
      throw new Error("Missing selection token")
    }
    expect(mocks.importSelected).not.toHaveBeenCalled()

    await expect(
      service.openConversation({
        ...scope,
        selectionToken: selected.selectionToken,
      }),
    ).resolves.toEqual({ conversationId: "6", contactInboxId: "4" })
    await expect(
      service.openConversation({
        ...scope,
        selectionToken: selected.selectionToken,
      }),
    ).resolves.toEqual({ conversationId: "6", contactInboxId: "4" })

    expect(mocks.importSelected).toHaveBeenCalledExactlyOnceWith(
      { ...scope, inboxId: "inbox-2", uid: peer, name: "Customer" },
      expect.any(Object),
    )
    expect(mocks.incrementImportedContacts).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: "1", userIds: ["owner", "tenant-owner"], count: 1 },
      tx,
    )
    expect(mocks.recoverFriendCaches).toHaveBeenCalledExactlyOnceWith(scope)
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })

  it("does not create the contact before a valid selection or open a failed import", async () => {
    mocks.directTarget.mockResolvedValue(null)
    mocks.dispatch.mockResolvedValue(applied({ contacts: [{ uid: peer }] }))
    await expect(
      service.openConversation({ ...scope, selectionToken: "missing" }),
    ).rejects.toThrow()
    expect(mocks.importSelected).not.toHaveBeenCalled()
    const lookup = await service.lookup({
      ...scope,
      commandId: "lookup",
      operation: { kind: "lookupUsername", username: "known" },
    })
    const selected = lookup.contacts[0]
    if (!selected) {
      throw new Error("Missing selection token")
    }
    mocks.importSelected.mockRejectedValue(new Error("Quota accounting failed"))

    await expect(
      service.openConversation({
        ...scope,
        selectionToken: selected.selectionToken,
      }),
    ).rejects.toThrow("Quota accounting failed")
    expect(mocks.findOrCreateConversation).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    "",
    "   ",
  ])("dispatches provider lookups when no account allowlist is configured (%s)", async (configuredAccounts) => {
    vi.stubEnv(
      "ZALO_ACCOUNT_CONTACT_OPERATIONS_ACCOUNT_IDS",
      configuredAccounts,
    )
    mocks.dispatch.mockResolvedValue(applied({ contacts: [{ uid: peer }] }))

    await expect(
      service.lookup({
        ...scope,
        commandId: "lookup",
        operation: { kind: "lookupUsername", username: "known" },
      }),
    ).resolves.toEqual({
      contacts: [{ uid: peer, selectionToken: expect.any(String) }],
    })
    expect(mocks.resolveAccount).toHaveBeenCalledExactlyOnceWith({
      workspaceId: scope.workspaceId,
      id: scope.accountId,
    })
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })

  it.each([
    "false",
    " False ",
    "3, 4",
  ])("does not dispatch provider calls for an explicitly restricted account (%s)", async (configuredAccounts) => {
    vi.stubEnv(
      "ZALO_ACCOUNT_CONTACT_OPERATIONS_ACCOUNT_IDS",
      configuredAccounts,
    )
    await expect(
      service.lookup({
        ...scope,
        commandId: "lookup",
        operation: { kind: "lookupUsername", username: "known" },
      }),
    ).rejects.toThrow("Zalo Account contacts are unavailable")
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it("requires an account in the selected workspace even without an allowlist", async () => {
    vi.stubEnv("ZALO_ACCOUNT_CONTACT_OPERATIONS_ACCOUNT_IDS", undefined)
    mocks.resolveAccount.mockResolvedValueOnce(undefined)

    await expect(
      service.lookup({
        ...scope,
        commandId: "lookup",
        operation: { kind: "lookupUsername", username: "known" },
      }),
    ).rejects.toThrow("Zalo Account not found")
    expect(mocks.resolveAccount).toHaveBeenCalledExactlyOnceWith({
      workspaceId: scope.workspaceId,
      id: scope.accountId,
    })
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })

  it("issues one scoped DM selection per distinct provider UID without returning lookup PII", async () => {
    mocks.dispatch.mockResolvedValue(
      applied({
        contacts: [
          { uid: peer, name: "Customer", profile: { phoneNumber: "private" } },
          { uid: peer, name: "Duplicate" },
          { uid: "999", name: "Self" },
        ],
      }),
    )
    const result = await service.lookup({
      ...scope,
      commandId: "lookup",
      operation: { kind: "lookupPhone", phone: "+84912345678" },
    })
    const selected = result.contacts[0]
    expect(result.contacts).toEqual([
      { uid: peer, name: "Customer", selectionToken: expect.any(String) },
    ])
    expect(selected).toBeDefined()
    if (!selected) {
      throw new Error("Missing selection token")
    }

    await expect(
      service.openConversation({
        ...scope,
        accountId: "3",
        selectionToken: selected.selectionToken,
      }),
    ).rejects.toThrow()
    await expect(
      service.openConversation({
        ...scope,
        selectionToken: selected.selectionToken,
      }),
    ).resolves.toEqual({ conversationId: "6", contactInboxId: "4" })
    expect(mocks.findOrCreateConversation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceId: "1",
        contactId: "5",
        sourceId: null,
      }),
    )
  })

  it("claims each mutation before dispatch and returns unknown without resending", async () => {
    mocks.dispatch.mockResolvedValue({ status: "unknown" })
    const command = {
      ...scope,
      commandId: "once",
      operation: { kind: "invite" as const, uid: peer, message: "Hello" },
    }

    await expect(service.mutate(command)).resolves.toEqual({
      status: "unknown",
    })
    await expect(service.mutate(command)).resolves.toEqual({
      status: "unknown",
    })
    await expect(
      service.mutate({
        ...command,
        operation: { ...command.operation, message: "Changed" },
      }),
    ).rejects.toThrow()
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })

  it("treats missing bulk peers as unknown and strips explicitly hidden timestamps", async () => {
    mocks.dispatch.mockResolvedValue(
      applied({
        presence: [{ uid: peer, status: "hidden", lastOnlineMs: 42 }],
      }),
    )
    const request = {
      ...scope,
      commandId: "presence",
      operation: { kind: "onlines" as const, uids: [peer, "1002"] },
    }
    const expected = {
      presence: [
        { uid: peer, status: "hidden" },
        { uid: "1002", status: "unknown" },
      ],
    }

    await expect(service.presence(request)).resolves.toEqual(expected)
    await expect(
      service.presence({ ...request, commandId: "presence-refresh" }),
    ).resolves.toEqual(expected)
    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  })
})
