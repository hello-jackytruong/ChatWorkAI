import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(),
  findGroup: vi.fn(),
  finishCompleteSync: vi.fn(),
  listGroups: vi.fn(),
  sendGroupAndWait: vi.fn(),
  syncGroupsAndWait: vi.fn(),
  updatePolicy: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountGroupRepository: {
    find: mocks.findGroup,
    finishCompleteSync: mocks.finishCompleteSync,
    list: mocks.listGroups,
    updatePolicy: mocks.updatePolicy,
    upsert: mocks.upsert,
  },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.findAccount },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    sendGroupAndWait: mocks.sendGroupAndWait,
    syncGroupsAndWait: mocks.syncGroupsAndWait,
  },
}))

const { zaloAccountGroupService } = await import(
  "../src/zalo-account/group.service"
)

const account = {
  id: "account-1",
  workspaceId: "workspace-1",
  inboxId: "inbox-1",
}

describe("zaloAccountGroupService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findAccount.mockResolvedValue(account)
    mocks.listGroups.mockResolvedValue([])
  })

  it("only marks missing groups after every provider group was persisted", async () => {
    mocks.syncGroupsAndWait.mockResolvedValue([
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
    ])

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
