import { describe, expect, it, vi } from "vitest"
import { runProviderGroupManagement } from "../src/runtime/group-management"

type Provider = Parameters<typeof runProviderGroupManagement>[0]
const providerGroupId = "100"

function provider(ownUid = "10", overrides: Record<string, unknown> = {}) {
  const group = {
    groupId: providerGroupId,
    name: "Before",
    creatorId: "10",
    adminIds: ["20"],
    memberIds: ["10", "20", "30", "40"],
    hasMoreMember: 0,
    totalMember: 4,
    setting: { blockName: 0 },
    ...overrides,
  }
  const getGroupInfo = vi.fn(async () => ({
    gridInfoMap: { [providerGroupId]: group },
  }))
  const authorize = vi.fn(async () => undefined)
  const createGroup = vi.fn(async () => ({
    groupId: "900",
    groupType: 1,
    sucessMembers: ["30", "999"],
    errorMembers: ["40"],
    error_data: { secret: "never expose raw provider errors" },
  }))
  const addGroupDeputy = vi.fn(async () => "")
  const changeGroupName = vi.fn(async () => ({ status: 0 }))
  const changeGroupOwner = vi.fn(async () => ({ time: 456 }))
  const getGroupLinkInfo = vi.fn(async () => ({
    groupId: providerGroupId,
    name: "Before",
    type: 1,
    totalMember: 4,
    currentMems: [{ id: "private roster" }],
  }))
  const getGroupLinkDetail = vi.fn(async () => ({
    enabled: 1,
    link: "https://zalo.me/g/example",
    expiration_date: 1000,
  }))
  const joinGroupLink = vi.fn(async () => "")
  const updateGroupSettings = vi.fn(async () => "")
  const upgradeGroupToCommunity = vi.fn(async () => "")
  const getGroupInviteBoxList = vi.fn(async () => ({
    invitations: [{ groupInfo: { groupId: "99", name: "Invitation" } }],
    hasMore: true,
    total: 8,
  }))
  const getGroupInviteBoxInfo = vi.fn(async () => ({
    groupInfo: { groupId: "99", name: "Invitation" },
  }))
  const deleteGroupInviteBox = vi.fn(async () => ({
    delInvitaionIds: ["55"],
    errMap: { "55": { err: 0 }, "99": { err: 166 } },
  }))
  const getGroupBlockedMember = vi.fn(async () => ({
    blocked_members: [{ id: "33", dName: "Blocked" }],
    has_more: 1,
  }))
  const getPendingGroupMembers = vi.fn(async () => ({}))
  const reviewPendingMemberRequest = vi.fn(async () => ({ "30": 0, "40": 166 }))
  const api = {
    getOwnId: () => ownUid,
    getGroupInfo,
    createGroup,
    addGroupDeputy,
    changeGroupName,
    changeGroupOwner,
    getGroupLinkInfo,
    getGroupLinkDetail,
    joinGroupLink,
    updateGroupSettings,
    upgradeGroupToCommunity,
    getGroupInviteBoxList,
    getGroupInviteBoxInfo,
    deleteGroupInviteBox,
    getGroupBlockedMember,
    getPendingGroupMembers,
    reviewPendingMemberRequest,
  }
  return { ...api, api: api as unknown as Provider, authorize, group }
}

describe("Zalo group management adapter", () => {
  it("rejects fresh nonowner privilege elevation without dispatching a provider write", async () => {
    const { api, getGroupInfo, addGroupDeputy, authorize } = provider("20", {
      adminIds: [],
    })
    await expect(
      runProviderGroupManagement(
        api,
        providerGroupId,
        {
          kind: "addGroupDeputy",
          memberUids: ["20"],
        },
        authorize,
      ),
    ).rejects.toThrow()
    expect(getGroupInfo).toHaveBeenCalledExactlyOnceWith(providerGroupId)
    expect(authorize).not.toHaveBeenCalled()
    expect(addGroupDeputy).not.toHaveBeenCalled()
  })

  it("confirms a rename from readback and calls the dispatch authorization once before writing", async () => {
    const { api, changeGroupName, getGroupInfo, authorize, group } = provider()
    getGroupInfo.mockResolvedValueOnce({
      gridInfoMap: { [providerGroupId]: group },
    })
    // The first live group read is the dispatch permission check, the second is readback.
    getGroupInfo.mockResolvedValueOnce({
      gridInfoMap: { [providerGroupId]: { ...group, name: "After" } },
    })
    await expect(
      runProviderGroupManagement(
        api,
        providerGroupId,
        { kind: "changeGroupName", name: "After" },
        authorize,
      ),
    ).resolves.toMatchObject({ kind: "changeGroupName", outcome: "confirmed" })
    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
      changeGroupName.mock.invocationCallOrder[0] ?? 0,
    )
    expect(getGroupInfo).toHaveBeenCalledTimes(2)
  })

  it("returns only known target outcomes for mixed group creation", async () => {
    const { api, createGroup, authorize } = provider()
    const result = await runProviderGroupManagement(
      api,
      undefined,
      { kind: "createGroup", name: "New", memberUids: ["30", "40"] },
      authorize,
    )
    expect(result).toMatchObject({
      kind: "createGroup",
      outcome: "partial",
      providerGroupId: "900",
      memberOutcomes: [
        { uid: "30", outcome: "confirmed" },
        { uid: "40", outcome: "rejected" },
      ],
    })
    expect(JSON.stringify(result)).not.toContain("999")
    expect(JSON.stringify(result)).not.toContain("never expose")
    expect(createGroup).toHaveBeenCalledExactlyOnceWith({
      name: "New",
      members: ["30", "40"],
    })
  })

  it("reports uncertainty after transfer timeout, makes no repeat write and never returns provider error text", async () => {
    const { api, changeGroupOwner, authorize } = provider()
    changeGroupOwner.mockRejectedValueOnce(
      new Error("sensitive transport failure"),
    )
    const result = await runProviderGroupManagement(
      api,
      providerGroupId,
      { kind: "changeGroupOwner", uid: "30" },
      authorize,
    )
    expect(result).toMatchObject({
      kind: "changeGroupOwner",
      outcome: "unknown",
    })
    expect(JSON.stringify(result)).not.toContain("sensitive")
    expect(authorize).toHaveBeenCalledOnce()
    expect(changeGroupOwner).toHaveBeenCalledExactlyOnceWith(
      "30",
      providerGroupId,
    )
  })

  it("inspects a Zalo link without joining or returning a roster and reports scoped expired links", async () => {
    const { api, getGroupLinkInfo, authorize, joinGroupLink } = provider()
    const result = await runProviderGroupManagement(
      api,
      undefined,
      { kind: "getGroupLinkInfo", link: "https://zalo.me/g/example" },
      authorize,
    )
    expect(result).toMatchObject({
      kind: "getGroupLinkInfo",
      group: { providerGroupId, name: "Before" },
    })
    expect(JSON.stringify(result)).not.toContain("private roster")
    expect(getGroupLinkInfo).toHaveBeenCalledExactlyOnceWith({
      link: "https://zalo.me/g/example",
      memberPage: 1,
    })
    expect(joinGroupLink).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    await expect(
      runProviderGroupManagement(
        api,
        providerGroupId,
        { kind: "getGroupLinkDetail" },
        authorize,
      ),
    ).resolves.toMatchObject({
      kind: "getGroupLinkDetail",
      outcome: "unavailable",
      reason: "expired",
    })
  })

  it("fails closed for destructive unsupported document and upgrade methods", async () => {
    const { api, authorize, updateGroupSettings, upgradeGroupToCommunity } =
      provider()
    await expect(
      runProviderGroupManagement(
        api,
        providerGroupId,
        { kind: "updateGroupSettings", settings: { lockSendMsg: true } },
        authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable", reason: "unsupported" })
    await expect(
      runProviderGroupManagement(
        api,
        providerGroupId,
        { kind: "upgradeGroupToCommunity" },
        authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable", reason: "unsupported" })
    expect(authorize).not.toHaveBeenCalled()
    expect(updateGroupSettings).not.toHaveBeenCalled()
    expect(upgradeGroupToCommunity).not.toHaveBeenCalled()
  })

  it("shows a pending join when Zalo requests membership approval", async () => {
    const { api, joinGroupLink, authorize } = provider()
    joinGroupLink.mockRejectedValueOnce(
      Object.assign(new Error("internal"), { code: 240 }),
    )
    await expect(
      runProviderGroupManagement(
        api,
        undefined,
        {
          kind: "joinGroupLink",
          link: "https://zalo.me/g/example",
        },
        authorize,
      ),
    ).resolves.toEqual({ kind: "joinGroupLink", outcome: "pending" })
    expect(joinGroupLink).toHaveBeenCalledExactlyOnceWith(
      "https://zalo.me/g/example",
    )
    expect(authorize).toHaveBeenCalledOnce()
  })

  it("uses only the selected invitation's result even when another deletion succeeded", async () => {
    const { api, getGroupInviteBoxInfo, deleteGroupInviteBox, authorize } =
      provider()
    await expect(
      runProviderGroupManagement(
        api,
        undefined,
        {
          kind: "deleteGroupInviteBox",
          invitedGroupId: "99",
        },
        authorize,
      ),
    ).resolves.toEqual({
      kind: "deleteGroupInviteBox",
      outcome: "rejected",
      reason: "permission",
      providerGroupId: "99",
      providerCode: 166,
    })
    expect(getGroupInviteBoxInfo).toHaveBeenCalledExactlyOnceWith({
      groupId: "99",
      mpage: 1,
      mcount: 1,
    })
    expect(deleteGroupInviteBox).toHaveBeenCalledExactlyOnceWith("99", false)
    expect(authorize).toHaveBeenCalledOnce()
  })

  it("normalizes native invitation and blocked pages and keeps incomplete pending results explicit", async () => {
    const { api, authorize, getGroupInviteBoxList, getGroupBlockedMember } =
      provider()
    await expect(
      runProviderGroupManagement(
        api,
        undefined,
        { kind: "getGroupInviteBoxList", page: 0, limit: 5 },
        authorize,
      ),
    ).resolves.toMatchObject({
      nextPage: 1,
      complete: false,
      entries: [{ id: "99", name: "Invitation" }],
    })
    expect(getGroupInviteBoxList).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0, invPerPage: 5 }),
    )
    await expect(
      runProviderGroupManagement(
        api,
        providerGroupId,
        { kind: "getGroupBlockedMember", page: 1, limit: 5 },
        authorize,
      ),
    ).resolves.toMatchObject({
      nextPage: 2,
      complete: false,
      entries: [{ id: "33", uid: "33", name: "Blocked" }],
    })
    expect(getGroupBlockedMember).toHaveBeenCalledExactlyOnceWith(
      { page: 1, count: 5 },
      providerGroupId,
    )
    await expect(
      runProviderGroupManagement(
        api,
        providerGroupId,
        { kind: "getPendingGroupMembers" },
        authorize,
      ),
    ).resolves.toMatchObject({ complete: false, entries: [] })
    expect(authorize).not.toHaveBeenCalled()
  })

  it("reports keyed approval results without treating all requested members as successful", async () => {
    const { api, authorize, reviewPendingMemberRequest } = provider()
    await expect(
      runProviderGroupManagement(
        api,
        providerGroupId,
        {
          kind: "reviewPendingMemberRequest",
          memberUids: ["30", "40"],
          approve: true,
        },
        authorize,
      ),
    ).resolves.toMatchObject({
      outcome: "partial",
      memberOutcomes: [
        { uid: "30", outcome: "confirmed", providerCode: 0 },
        { uid: "40", outcome: "rejected", providerCode: 166 },
      ],
    })
    expect(reviewPendingMemberRequest).toHaveBeenCalledExactlyOnceWith(
      { members: ["30", "40"], isApprove: true },
      providerGroupId,
    )
  })
})
