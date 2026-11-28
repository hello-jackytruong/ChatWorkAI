import { describe, expect, it, vi } from "vitest"
import { readProviderGroupAdministration } from "../src/runtime/group-administration"

type Provider = Parameters<typeof readProviderGroupAdministration>[0]
const scope = { workspaceId: "workspace-1", accountId: "account-1" }

function provider(overrides: Record<string, unknown> = {}, ownUid = "10") {
  const group = {
    groupId: "group-1",
    name: "Team",
    creatorId: "10",
    adminIds: ["10", "20", "20"],
    memberIds: ["10", "20", "20"],
    memVerList: ["30_123", "40_456"],
    currentMems: [{ id: "10", dName: "Own account" }],
    version: "8",
    totalMember: 6,
    hasMoreMember: 2,
    setting: { lockViewMember: 1, lockSendMsg: 0, unknownSecret: "ignored" },
    ...overrides,
  }
  const getGroupInfo = vi.fn(async () => ({
    gridInfoMap: { "group-1": group },
  }))
  const getGroupMembersInfo = vi.fn(async () => ({
    profiles: {
      "20": { id: "20", displayName: "Deputy" },
      "30": { id: "unrelated", displayName: "Ignore" },
      "99": { id: "99", displayName: "Unrequested" },
    },
  }))
  const getRelatedFriendGroup = vi.fn(async () => ({
    groupRelateds: { "30": ["200"], "99": ["900"] },
  }))
  const getFriendRequestStatus = vi.fn(async () => ({ is_friend: 1 }))
  const fetchAccountInfo = vi.fn(async () => ({
    profile: { bizPkg: { pkgId: 2 } },
  }))
  const api = {
    getGroupInfo,
    getGroupMembersInfo,
    getOwnId: () => ownUid,
    getRelatedFriendGroup,
    getFriendRequestStatus,
    fetchAccountInfo,
  }
  return {
    api: api as unknown as Provider,
    getGroupInfo,
    getGroupMembersInfo,
    getRelatedFriendGroup,
    getFriendRequestStatus,
    fetchAccountInfo,
  }
}

describe("Zalo group administration provider reads", () => {
  it("projects safe community metadata and computes role with only known flags", async () => {
    const { api, getGroupMembersInfo } = provider(
      {
        type: 2,
        desc: "Team description",
      },
      "20",
    )
    await expect(
      readProviderGroupAdministration(
        api,
        "group-1",
        { kind: "overview" },
        scope,
      ),
    ).resolves.toMatchObject({
      kind: "overview",
      overview: {
        type: "community",
        description: "Team description",
        ownerUid: "10",
        deputyUids: ["20"],
        role: "deputy",
        settings: { lockViewMember: true, lockSendMsg: false },
      },
    })
    expect(getGroupMembersInfo).not.toHaveBeenCalled()
    const legacy = provider(
      { creatorId: undefined, adminIds: undefined, setting: undefined },
      "50",
    )
    const result = await readProviderGroupAdministration(
      legacy.api,
      "group-1",
      { kind: "overview" },
      scope,
    )
    expect(result).toMatchObject({
      kind: "overview",
      overview: { role: "unknown" },
    })
    if (result.kind === "overview") {
      expect(result.overview).not.toHaveProperty("settings")
      expect(result.overview).not.toHaveProperty("type")
    }
  })

  it("includes the account, dedupes roster IDs and only batches missing IDs on this page", async () => {
    const { api, getGroupMembersInfo } = provider()
    const result = await readProviderGroupAdministration(
      api,
      "group-1",
      { kind: "members", limit: 3 },
      scope,
    )
    expect(result).toMatchObject({
      kind: "members",
      complete: false,
      visibility: "visible",
      nextCursor: expect.any(String),
      members: [
        { uid: "10", name: "Own account", role: "owner", isSelf: true },
        { uid: "20", name: "Deputy", role: "deputy" },
        { uid: "30", role: "member" },
      ],
    })
    expect(getGroupMembersInfo).toHaveBeenCalledExactlyOnceWith(["20", "30"])
    if (result.kind !== "members" || !result.nextCursor) {
      throw new Error("Expected a subsequent page")
    }
    await expect(
      readProviderGroupAdministration(
        api,
        "group-1",
        { kind: "members", cursor: result.nextCursor, limit: 3 },
        scope,
      ),
    ).resolves.toMatchObject({
      kind: "members",
      complete: false,
      members: [{ uid: "40" }],
    })
    expect(getGroupMembersInfo).toHaveBeenLastCalledWith(["40"])
    await expect(
      readProviderGroupAdministration(
        api,
        "group-1",
        { kind: "members", cursor: result.nextCursor, limit: 3 },
        { ...scope, accountId: "account-2" },
      ),
    ).rejects.toThrow()
    const changed = provider({ version: "9" })
    await expect(
      readProviderGroupAdministration(
        changed.api,
        "group-1",
        { kind: "members", cursor: result.nextCursor, limit: 3 },
        scope,
      ),
    ).rejects.toThrow()
    expect(changed.getGroupMembersInfo).not.toHaveBeenCalled()
  })

  it("returns an explicitly restricted roster for a member without fetching any profiles", async () => {
    const { api, getGroupMembersInfo } = provider({}, "30")
    await expect(
      readProviderGroupAdministration(
        api,
        "group-1",
        { kind: "members", limit: 50 },
        scope,
      ),
    ).resolves.toEqual({
      kind: "members",
      complete: false,
      visibility: "restricted",
      members: [],
    })
    expect(getGroupMembersInfo).not.toHaveBeenCalled()
  })

  it("reads related groups only for the selected known friend in a Zalo Business account", async () => {
    const {
      api,
      getRelatedFriendGroup,
      fetchAccountInfo,
      getFriendRequestStatus,
      getGroupMembersInfo,
    } = provider()
    await expect(
      readProviderGroupAdministration(
        api,
        "group-1",
        { kind: "related", uid: "99" },
        scope,
      ),
    ).resolves.toEqual({
      kind: "related",
      providerGroupIds: [],
      complete: false,
    })
    expect(fetchAccountInfo).not.toHaveBeenCalled()
    expect(getRelatedFriendGroup).not.toHaveBeenCalled()
    await expect(
      readProviderGroupAdministration(
        api,
        "group-1",
        { kind: "related", uid: "30" },
        scope,
      ),
    ).resolves.toEqual({
      kind: "related",
      providerGroupIds: ["200"],
      complete: true,
    })
    expect(getRelatedFriendGroup).toHaveBeenCalledExactlyOnceWith("30")
    expect(getFriendRequestStatus).toHaveBeenCalledExactlyOnceWith("30")
    expect(getGroupMembersInfo).not.toHaveBeenCalled()
    const withoutPlan = provider()
    withoutPlan.fetchAccountInfo.mockResolvedValue({
      profile: { bizPkg: { pkgId: 0 } },
    })
    await expect(
      readProviderGroupAdministration(
        withoutPlan.api,
        "group-1",
        { kind: "related", uid: "30" },
        scope,
      ),
    ).resolves.toEqual({
      kind: "related",
      providerGroupIds: [],
      complete: false,
    })
    expect(withoutPlan.getRelatedFriendGroup).not.toHaveBeenCalled()
  })
})
