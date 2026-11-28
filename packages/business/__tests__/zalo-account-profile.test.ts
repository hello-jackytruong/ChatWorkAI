import { beforeEach, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  account: vi.fn(),
  binding: vi.fn(),
  group: vi.fn(),
  groupMembers: vi.fn(),
  listMessages: vi.fn(),
  find: vi.fn(),
  store: vi.fn(),
  provider: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  createMessageRepository: async () => ({ listByConversation: m.listMessages }),
  integrationZaloAccountGroupRepository: { findByAnchor: m.group },
  zaloAccountSendAttemptRepository: { preparedContext: m.binding },
  zaloAccountUserProfileRepository: { find: m.find, observe: m.store },
}))
vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: {
    runExclusive: ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  },
  isLockAcquisitionError: () => false,
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: m.account },
}))
vi.mock("../src/zalo-account-media/resource-capture", () => ({
  captureZaloAccountResourceMedia: vi.fn(),
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    getGroupMembersAndWait: m.groupMembers,
    readProfilesAndWait: m.provider,
  },
}))

const { zaloAccountProfileService } = await import(
  "../src/zalo-account/profile.service"
)
const input = {
  workspaceId: "1",
  accountId: "2",
  conversationId: "3",
  contactInboxId: "4",
}
const direct = {
  id: "4",
  channel: "zaloAccount",
  contactKind: "person",
  sourceId: "42",
  contactId: "6",
}
const source = "getUserInfo" as const
const observedAt = Date.now()
const fields = {
  zaloName: { value: "Provider", source, observedAt },
  publicPhone: { value: "+12025550101", source, observedAt },
  globalId: { value: "global", source, observedAt },
}
const row = {
  providerUid: "42",
  fields,
  visibleFields: Object.keys(fields),
  observedAt: new Date(observedAt),
  detailObservedAt: new Date(observedAt),
  largeAvatarObservedAt: null,
}

beforeEach(() => {
  vi.resetAllMocks()
  m.account.mockResolvedValue({
    id: "2",
    inboxId: "5",
    zaloUid: "21",
    groupMessagingEnabled: true,
    groupPolicyEpoch: 7,
  })
  m.binding.mockResolvedValue({
    conversation: { id: "3", workspaceId: "1", createdAt: new Date(0) },
    contactInbox: direct,
  })
  m.find.mockResolvedValue(row)
  m.listMessages.mockResolvedValue({ data: [] })
  m.groupMembers.mockResolvedValue({ members: [], complete: true })
})

it("authorizes the exact direct peer and never loads a foreign account snapshot", async () => {
  await expect(
    zaloAccountProfileService.get({ ...input, memberUid: "99" }),
  ).rejects.toThrow()
  expect(m.find).not.toHaveBeenCalled()
  expect(m.provider).not.toHaveBeenCalled()
  m.binding.mockResolvedValue(null)
  await expect(zaloAccountProfileService.get(input)).rejects.toThrow()
  expect(m.find).not.toHaveBeenCalled()
})

it("returns only visible scoped source fields and does not refresh a fresh detail", async () => {
  m.find.mockResolvedValue({ ...row, visibleFields: ["zaloName", "globalId"] })
  const actual = await zaloAccountProfileService.get({
    ...input,
    refresh: true,
  })
  expect(actual).toEqual({
    profile: { uid: "42", fields: { zaloName: fields.zaloName.value } },
    staleness: "fresh",
    observedAt,
  })
  expect(m.find).toHaveBeenCalledWith({
    workspaceId: "1",
    accountId: "2",
    providerUid: "42",
  })
  expect(m.provider).not.toHaveBeenCalled()
})

it("refreshes a missing profile once and stores no data for inconsistent provider IDs", async () => {
  m.find.mockResolvedValue(null)
  m.provider.mockResolvedValue([{ uid: "99", fields }])
  await expect(zaloAccountProfileService.get(input)).resolves.toEqual({
    profile: null,
    staleness: "unavailable",
  })
  expect(m.provider).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ profileQuery: { uids: ["42"] } }),
  )
  expect(m.store).not.toHaveBeenCalled()
  m.provider.mockResolvedValue([{ uid: "42", fields }])
  m.store.mockResolvedValue([row])
  await expect(zaloAccountProfileService.get(input)).resolves.toMatchObject({
    staleness: "fresh",
  })
  expect(m.store).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      workspaceId: "1",
      accountId: "2",
      profiles: [{ uid: "42", fields }],
    }),
  )
})

it("rejects unverified group actors and keeps public phone out of roster profile reads", async () => {
  m.binding.mockResolvedValue({
    conversation: { id: "3", workspaceId: "1", createdAt: new Date(0) },
    contactInbox: {
      ...direct,
      contactKind: "channelGroup",
      sourceId: "za:group:g1",
    },
  })
  m.group.mockResolvedValue({
    id: "8",
    accountId: "2",
    accessible: true,
    receiveEnabled: true,
    providerGroupId: "g1",
    policyEpoch: 9,
  })
  await expect(
    zaloAccountProfileService.get({
      ...input,
      memberUid: "42",
      refresh: false,
    }),
  ).rejects.toThrow()
  expect(m.find).not.toHaveBeenCalled()
  m.listMessages.mockResolvedValue({
    data: [
      {
        sourceId: "za:2:group:g1:msg",
        contactInboxId: "4",
        contentAttributes: { zaloAccount: { group: { senderId: "42" } } },
      },
    ],
  })
  const result = await zaloAccountProfileService.get({
    ...input,
    memberUid: "42",
    refresh: false,
  })
  expect(result.profile?.fields).toEqual({ zaloName: fields.zaloName.value })
  expect(m.provider).not.toHaveBeenCalled()
})
