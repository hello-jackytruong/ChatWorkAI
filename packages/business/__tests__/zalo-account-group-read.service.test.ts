import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(),
  findGroup: vi.fn(),
  findByProviderId: vi.fn(),
  listAccessibleByProviderIds: vi.fn(),
  readGroupAdministrationAndWait: vi.fn(),
  storeNativeOverview: vi.fn(),
}))

vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.findAccount },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    readGroupAdministrationAndWait: mocks.readGroupAdministrationAndWait,
  },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountGroupRepository: {
    find: mocks.findGroup,
    findByProviderId: mocks.findByProviderId,
    listAccessibleByProviderIds: mocks.listAccessibleByProviderIds,
    storeNativeOverview: mocks.storeNativeOverview,
  },
}))

const { zaloAccountGroupReadService } = await import(
  "../src/zalo-account/group-read.service"
)

const scope = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  groupId: "group-1",
}
const group = {
  id: "group-1",
  providerGroupId: "provider-group-1",
  name: "Stored Group",
  accessible: true,
  policyEpoch: 3,
  conversationId: null,
  contactInboxId: null,
  sendEnabled: false,
  receiveEnabled: false,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.findAccount.mockResolvedValue({
    id: "account-1",
    workspaceId: "workspace-1",
    inboxId: "inbox-1",
    groupPolicyEpoch: 2,
    groupMessagingEnabled: false,
  })
  mocks.findGroup.mockResolvedValue(group)
  mocks.findByProviderId.mockResolvedValue(group)
})

describe("Zalo account group administration reads", () => {
  it("reads the exact account group without an Inbox conversation or send policy", async () => {
    const members = {
      kind: "members",
      members: [{ uid: "account-native", role: "owner" }],
      complete: true,
      visibility: "visible",
    }
    mocks.readGroupAdministrationAndWait.mockResolvedValue(members)
    await expect(
      zaloAccountGroupReadService.members(scope),
    ).resolves.toMatchObject(members)
    expect(mocks.findGroup).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      id: "group-1",
    })
    expect(mocks.readGroupAdministrationAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        groupId: "provider-group-1",
        accountPolicyEpoch: 2,
        groupPolicyEpoch: 3,
        groupRead: { kind: "members", limit: 20 },
      }),
    )
  })

  it("rejects current native reads when access was lost or the runtime belongs to another Inbox", async () => {
    const admission = {
      ...scope,
      providerGroupId: group.providerGroupId,
      inboxId: "inbox-1",
      accountPolicyEpoch: 2,
      groupPolicyEpoch: 3,
    }
    await expect(
      zaloAccountGroupReadService.admit(admission),
    ).resolves.toBeUndefined()
    await expect(
      zaloAccountGroupReadService.admit({
        ...admission,
        inboxId: "other-inbox",
      }),
    ).rejects.toThrow()
    mocks.findByProviderId.mockResolvedValue({ ...group, accessible: false })
    await expect(zaloAccountGroupReadService.admit(admission)).rejects.toThrow()
    mocks.findGroup.mockResolvedValue(null)
    await expect(zaloAccountGroupReadService.members(scope)).rejects.toThrow()
    expect(mocks.readGroupAdministrationAndWait).not.toHaveBeenCalled()
  })

  it("retains a safe legacy overview with explicitly unknown role when the account cannot be queried", async () => {
    mocks.readGroupAdministrationAndWait.mockRejectedValue(new Error("offline"))
    await expect(
      zaloAccountGroupReadService.overview(scope),
    ).resolves.toMatchObject({
      groupId: "group-1",
      name: "Stored Group",
      role: "unknown",
      accessible: true,
    })
    expect(mocks.storeNativeOverview).not.toHaveBeenCalled()
  })

  it("returns only known accessible groups for an explicitly selected member", async () => {
    mocks.readGroupAdministrationAndWait.mockResolvedValue({
      kind: "related",
      providerGroupIds: [
        "provider-group-1",
        "provider-group-2",
        "hidden-group",
      ],
      complete: true,
    })
    mocks.listAccessibleByProviderIds.mockResolvedValue([
      { id: "group-2", name: "Shared group" },
    ])
    await expect(
      zaloAccountGroupReadService.related({ ...scope, uid: "20" }),
    ).resolves.toEqual({
      groups: [{ groupId: "group-2", name: "Shared group" }],
      complete: false,
    })
    expect(mocks.listAccessibleByProviderIds).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      providerGroupIds: ["provider-group-2", "hidden-group"],
    })
  })
})
