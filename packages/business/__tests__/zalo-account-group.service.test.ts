import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(),
  findGroup: vi.fn(),
  finishCompleteSync: vi.fn(),
  listGroups: vi.fn(),
  sendGroupAndWait: vi.fn(),
  syncGroupsAndWait: vi.fn(),
  getGroupMembersAndWait: vi.fn(),
  updatePolicy: vi.fn(),
  updateInboxPolicy: vi.fn(),
  upsert: vi.fn(),
  takeRate: vi.fn(),
  beginSync: vi.fn(),
}))
vi.mock("../src/zalo-account/group-rate-limit", () => ({
  takeGroupSendCapacity: mocks.takeRate,
}))
vi.mock("../src/zalo-account/send-attempt.service", () => ({
  zaloAccountSendAttemptService: {
    send: async (input, dispatch) => await dispatch(input.commandId),
  },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecordSafely: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountRepository: {
    beginGroupSync: mocks.beginSync,
    commitGroupSync: async (
      _input: unknown,
      fn: (tx: object) => Promise<unknown>,
    ) => await fn({}),
  },
  integrationZaloAccountGroupRepository: {
    find: mocks.findGroup,
    findByProviderId: mocks.findGroup,
    finishCompleteSync: mocks.finishCompleteSync,
    list: mocks.listGroups,
    updatePolicy: mocks.updatePolicy,
    updateInboxPolicy: mocks.updateInboxPolicy,
    upsert: mocks.upsert,
  },
}))
vi.mock("@chatbotx.io/database/client", () => ({
  db: {
    transaction: async (fn: (tx: object) => Promise<unknown>) => await fn({}),
  },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.findAccount },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    sendGroupAndWait: mocks.sendGroupAndWait,
    syncGroupsAndWait: mocks.syncGroupsAndWait,
    getGroupMembersAndWait: mocks.getGroupMembersAndWait,
  },
}))

const { zaloAccountGroupService } = await import(
  "../src/zalo-account/group.service"
)

const account = {
  id: "account-1",
  workspaceId: "workspace-1",
  inboxId: "inbox-1",
  groupMessagingEnabled: true,
}

describe("zaloAccountGroupService", () => {
  it("queries members only for the exact anchored group and current policy epochs", async () => {
    mocks.findAccount.mockResolvedValue({
      ...account,
      groupPolicyEpoch: 2,
      zaloUid: "self",
    })
    mocks.findGroup.mockResolvedValue({
      id: "group-1",
      providerGroupId: "native-1",
      conversationId: "conversation-1",
      contactInboxId: "ci-1",
      accessible: true,
      sendEnabled: true,
      policyEpoch: 3,
    })
    mocks.getGroupMembersAndWait.mockResolvedValue({
      members: [{ uid: "self" }, { uid: "peer-1", name: "Linh" }],
      complete: false,
    })
    const input = {
      workspaceId: "workspace-1",
      accountId: "account-1",
      groupId: "group-1",
      conversationId: "conversation-1",
      query: "Linh",
    }
    await expect(zaloAccountGroupService.listMembers(input)).resolves.toEqual({
      members: [{ uid: "peer-1", name: "Linh" }],
      complete: false,
    })
    expect(mocks.getGroupMembersAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: "inbox-1",
        groupId: "native-1",
        accountPolicyEpoch: 2,
        groupPolicyEpoch: 3,
        groupMemberQuery: { query: "Linh", limit: 20 },
      }),
    )
    await expect(
      zaloAccountGroupService.listMembers({
        ...input,
        conversationId: "other",
      }),
    ).rejects.toThrow()
    expect(mocks.getGroupMembersAndWait).toHaveBeenCalledOnce()
  })

  it("fences repeated sync calls independently even when the caller reuses its command ID", async () => {
    mocks.syncGroupsAndWait.mockResolvedValue({ groups: [], complete: true })
    const input = {
      workspaceId: "workspace-1",
      accountId: "account-1",
      commandId: "same-caller-id",
    }
    await zaloAccountGroupService.sync(input)
    await zaloAccountGroupService.sync(input)
    expect(mocks.beginSync.mock.calls[0][0].runId).not.toBe(
      mocks.beginSync.mock.calls[1][0].runId,
    )
    expect(mocks.syncGroupsAndWait.mock.calls[0][0].commandId).not.toBe(
      mocks.syncGroupsAndWait.mock.calls[1][0].commandId,
    )
  })
  it("never refreshes an old queued audience into a new policy epoch", async () => {
    mocks.findAccount.mockResolvedValue({ ...account, groupPolicyEpoch: 2 })
    mocks.findGroup.mockResolvedValue({
      id: "g1",
      providerGroupId: "g1",
      accessible: true,
      sendEnabled: true,
      policyEpoch: 3,
    })
    await expect(
      zaloAccountGroupService.send({
        workspaceId: "workspace-1",
        accountId: "account-1",
        groupId: "g1",
        commandId: "old",
        message: { text: "hello", attachments: [] },
        audience: {
          kind: "zaloAccountGroup",
          workspaceId: "workspace-1",
          accountId: "account-1",
          groupId: "g1",
          providerGroupId: "g1",
          contactInboxId: "ci",
          conversationId: "conv",
          origin: "inbox",
          accountPolicyEpoch: 1,
          groupPolicyEpoch: 3,
        },
      }),
    ).rejects.toThrow("policy changed")
    expect(mocks.sendGroupAndWait).not.toHaveBeenCalled()
  })
  it("rechecks both policy epochs before consuming provider capacity", async () => {
    mocks.findAccount.mockResolvedValue({ ...account, groupPolicyEpoch: 2 })
    mocks.findGroup.mockResolvedValue({
      accessible: true,
      sendEnabled: true,
      policyEpoch: 3,
    })
    const input = {
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
      providerGroupId: "g1",
      accountPolicyEpoch: 2,
      groupPolicyEpoch: 2,
    }
    await expect(zaloAccountGroupService.admitSend(input)).rejects.toThrow(
      "policy changed",
    )
    expect(mocks.takeRate).not.toHaveBeenCalled()
    await zaloAccountGroupService.admitSend({ ...input, groupPolicyEpoch: 3 })
    expect(mocks.takeRate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerGroupId: "g1",
        accountId: "account-1",
      }),
    )
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findAccount.mockResolvedValue(account)
    mocks.listGroups.mockResolvedValue([])
  })
  it("account kill switch blocks an otherwise enabled group", async () => {
    mocks.findAccount.mockResolvedValue({
      ...account,
      groupMessagingEnabled: false,
    })
    mocks.findGroup.mockResolvedValue({
      id: "g1",
      providerGroupId: "g1",
      accessible: true,
      sendEnabled: true,
    })
    await expect(
      zaloAccountGroupService.send({
        workspaceId: "workspace-1",
        accountId: "account-1",
        groupId: "g1",
        commandId: "cmd1",
        message: { text: "hello", attachments: [] },
      }),
    ).rejects.toThrow("group sending is disabled")
    expect(mocks.sendGroupAndWait).not.toHaveBeenCalled()
  })

  it("provisions receive policy through the account-scoped transactional anchor repository", async () => {
    mocks.updateInboxPolicy.mockResolvedValue({
      id: "g1",
      receiveEnabled: true,
      policyEpoch: 1,
    })
    const result = await zaloAccountGroupService.updateInboxPolicy({
      workspaceId: "workspace-1",
      accountId: "account-1",
      id: "g1",
      receiveEnabled: true,
    })
    expect(result).toMatchObject({ receiveEnabled: true, policyEpoch: 1 })
    expect(mocks.updateInboxPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        id: "g1",
        receiveEnabled: true,
      }),
      expect.anything(),
    )
    expect(mocks.sendGroupAndWait).not.toHaveBeenCalled()
  })

  it("only marks missing groups after every provider group was persisted", async () => {
    mocks.syncGroupsAndWait.mockResolvedValue({
      complete: true,
      groups: [
        {
          providerGroupId: "group-1",
          name: "Group one",
          memberCount: 3,
        },
        {
          providerGroupId: "group-2",
          name: "Group two",
          memberCount: 5,
        },
      ],
    })

    await zaloAccountGroupService.sync({
      workspaceId: "workspace-1",
      accountId: "account-1",
      commandId: "sync-1",
    })

    expect(mocks.upsert).toHaveBeenCalledTimes(2)
    const lastUpsertOrder = mocks.upsert.mock.invocationCallOrder.at(-1) ?? 0
    const finishOrder =
      mocks.finishCompleteSync.mock.invocationCallOrder.at(0) ?? 0
    expect(finishOrder).toBeGreaterThan(lastUpsertOrder)
  })
  it("never disables known groups from a partial or legacy snapshot", async () => {
    for (const snapshot of [
      [],
      { groups: [], complete: false, reason: "truncated" },
    ]) {
      mocks.syncGroupsAndWait.mockResolvedValue(snapshot)
      await zaloAccountGroupService.sync({
        workspaceId: "workspace-1",
        accountId: "account-1",
        commandId: "partial",
      })
    }
    expect(mocks.finishCompleteSync).not.toHaveBeenCalled()
  })

  it("fails closed before transport when group sending is disabled", async () => {
    mocks.findGroup.mockResolvedValue({
      id: "local-group-1",
      providerGroupId: "provider-group-1",
      accessible: true,
      sendEnabled: false,
    })

    await expect(
      zaloAccountGroupService.send({
        workspaceId: "workspace-1",
        accountId: "account-1",
        groupId: "local-group-1",
        commandId: "send-1",
        message: { text: "hello", attachments: [], quote: undefined },
      }),
    ).rejects.toThrow("group sending is disabled")
    expect(mocks.sendGroupAndWait).not.toHaveBeenCalled()
  })

  it("sends by provider group id only after policy authorization", async () => {
    mocks.findGroup.mockResolvedValue({
      id: "local-group-1",
      providerGroupId: "provider-group-1",
      accessible: true,
      sendEnabled: true,
    })
    mocks.sendGroupAndWait.mockResolvedValue({
      messageIds: ["provider-message-1"],
      sentCount: 1,
    })

    await zaloAccountGroupService.send({
      workspaceId: "workspace-1",
      accountId: "account-1",
      groupId: "local-group-1",
      commandId: "send-1",
      message: { text: "hello", attachments: [], quote: undefined },
    })

    expect(mocks.sendGroupAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "provider-group-1",
        inboxId: "inbox-1",
      }),
    )
  })
})
