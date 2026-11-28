import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  sync: vi.fn(),
  policy: vi.fn(),
  labels: vi.fn(),
  send: vi.fn(),
  inspect: vi.fn(),
  status: vi.fn(),
  groups: vi.fn(),
  projectProfiles: vi.fn(),
}))
vi.mock("@/lib/auth/require-workspace-permission", () => ({
  requireWorkspacePermission: mocks.permission,
}))
vi.mock("@/lib/safe-action", () => ({
  workspaceActionClient: {
    bindArgsSchemas() {
      return this
    },
    inputSchema() {
      return this
    },
    action(fn: unknown) {
      return fn
    },
  },
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountGroupService: {
    sync: mocks.sync,
    updateInboxPolicy: mocks.policy,
    list: mocks.groups,
  },
  zaloAccountLabelService: { sync: mocks.labels },
  zaloAccountService: { status: mocks.status },
  zaloAccountFriendSyncService: { sync: vi.fn() },
}))
vi.mock("@chatbotx.io/business/zalo-account/canonical-send", () => ({
  zaloAccountCanonicalSendService: {
    send: mocks.send,
    getOutcomeByMessage: mocks.inspect,
  },
}))
vi.mock("@chatbotx.io/business/zalo-account-media", () => ({
  zaloAccountMediaReadService: { projectProfiles: mocks.projectProfiles },
}))
const { withZaloGroupResources } = await import(
  "../src/features/zalo-accounts/lib/to-resource"
)
const { syncZaloAccountGroupsAction } = await import(
  "../src/features/zalo-accounts/actions/sync-groups.action"
)
const { syncZaloAccountLabelsAction } = await import(
  "../src/features/zalo-accounts/actions/sync-labels.action"
)
const { updateZaloAccountGroupPolicyAction } = await import(
  "../src/features/zalo-accounts/actions/update-group-policy.action"
)
const { getZaloAccountStatusAction, getZaloAccountOperationsAction } =
  await import(
    "../src/features/zalo-accounts/actions/account-operations.action"
  )
beforeEach(() => {
  vi.clearAllMocks()
  mocks.permission.mockRejectedValue(new Error("forbidden"))
})
it("independently rejects settings actions before any provider or policy write", async () => {
  const args = {
    bindArgsParsedInputs: ["workspace", "account"],
    parsedInput: { groupId: "group", sendEnabled: true },
  }
  for (const action of [
    syncZaloAccountGroupsAction,
    syncZaloAccountLabelsAction,
    updateZaloAccountGroupPolicyAction,
  ]) {
    await expect(
      (action as unknown as (arg: unknown) => Promise<unknown>)(args),
    ).rejects.toThrow("forbidden")
  }
  expect(mocks.permission).toHaveBeenCalledWith("workspace", "superAdmin")
  expect(mocks.sync).not.toHaveBeenCalled()
  expect(mocks.policy).not.toHaveBeenCalled()
  expect(mocks.labels).not.toHaveBeenCalled()
})

it("denies status to a member without superAdmin even with a workspace account ID", async () => {
  await expect(
    (
      getZaloAccountStatusAction as unknown as (
        input: unknown,
      ) => Promise<unknown>
    )({ bindArgsParsedInputs: ["workspace", "account"] }),
  ).rejects.toThrow("forbidden")
  expect(mocks.status).not.toHaveBeenCalled()
  expect(mocks.groups).not.toHaveBeenCalled()
})

it("keeps provider administration details out of legacy group summaries", async () => {
  const at = new Date()
  const row = {
    id: "1",
    workspaceId: "2",
    accountId: "3",
    providerGroupId: "4",
    name: "Group",
    avatarUrl: null,
    memberCount: 2,
    providerVersion: null,
    sendEnabled: false,
    receiveEnabled: false,
    automationMode: "disabled" as const,
    contactInboxId: null,
    conversationId: null,
    accessible: true,
    lastSyncRunId: "5",
    lastSyncedAt: at,
    inaccessibleAt: null,
    createdAt: at,
    updatedAt: at,
    nativeDetails: { role: "owner", ownerUid: "6" },
    nativeMetadataAt: at,
  }
  mocks.permission.mockResolvedValue(undefined)
  mocks.sync.mockResolvedValue([row])
  mocks.policy.mockResolvedValue(row)
  mocks.projectProfiles.mockResolvedValue(new Map())
  const args = {
    bindArgsParsedInputs: ["2", "3"],
    parsedInput: { groupId: "1", sendEnabled: true },
  }
  const [listed] = await withZaloGroupResources("2", [row])
  const synced = await (
    syncZaloAccountGroupsAction as unknown as (
      input: unknown,
    ) => Promise<unknown[]>
  )(args)
  const updated = await (
    updateZaloAccountGroupPolicyAction as unknown as (
      input: unknown,
    ) => Promise<unknown>
  )(args)
  for (const summary of [listed, ...synced, updated]) {
    expect(summary).toMatchObject({ id: "1", name: "Group" })
    expect(summary).not.toHaveProperty("nativeDetails")
    expect(summary).not.toHaveProperty("nativeMetadataAt")
  }
})

const safeStatus = {
  accountId: "account",
  status: "connected",
  reason: null,
  groupMessagingEnabled: false,
  gatewayAvailable: true,
  capabilities: {
    text: true,
    image: true,
    file: true,
    typing: true,
    reactions: true,
    receiveReactions: true,
    requestReactionHistory: false,
    sendReceipts: false,
    revoke: true,
    delete: true,
  },
  groups: { complete: false, count: 0, completedAt: null, reason: null },
  friends: {
    complete: false,
    count: 0,
    completedAt: null,
    reason: null,
    nextCursor: null,
  },
  labels: {
    complete: false,
    version: 0,
    paused: false,
    completedAt: null,
    reason: null,
  },
  runtime: null,
}
it("loads status without listing groups and preserves full operations for group consumers", async () => {
  mocks.permission.mockResolvedValue(undefined)
  mocks.status.mockResolvedValue(safeStatus)
  mocks.groups.mockResolvedValue([])
  const args = { bindArgsParsedInputs: ["workspace", "account"] }
  const status = await (
    getZaloAccountStatusAction as unknown as (arg: unknown) => Promise<unknown>
  )(args)
  expect(status).toEqual(safeStatus)
  expect(mocks.status).toHaveBeenCalledWith({
    workspaceId: "workspace",
    accountId: "account",
  })
  expect(mocks.groups).not.toHaveBeenCalled()
  const full = await (
    getZaloAccountOperationsAction as unknown as (
      arg: unknown,
    ) => Promise<unknown>
  )(args)
  expect(full).toEqual({ status: safeStatus, groups: [] })
  expect(mocks.groups).toHaveBeenCalledWith({
    workspaceId: "workspace",
    accountId: "account",
  })
  expect(mocks.permission).toHaveBeenCalledTimes(2)
})

it("checks superAdmin before message inspection and shares the scoped canonical outcome", async () => {
  const { inspectZaloAccountMessageAction } = await import(
    "../src/features/zalo-accounts/actions/account-operations.action"
  )
  const input = {
    bindArgsParsedInputs: ["workspace", "account"],
    parsedInput: {
      messageId: "12",
      messageCreatedAt: new Date("2026-11-23T00:00:00Z"),
    },
  }
  const inspect = inspectZaloAccountMessageAction as unknown as (
    input: unknown,
  ) => Promise<unknown>
  await expect(inspect(input)).rejects.toThrow("forbidden")
  expect(mocks.inspect).not.toHaveBeenCalled()
  mocks.permission.mockResolvedValue(undefined)
  const safe = {
    commandId: "c",
    status: "unknown",
    messageId: "12",
    messageCreatedAt: "2026-11-23T00:00:00.000Z",
    messageIds: [],
  }
  mocks.inspect.mockResolvedValue(safe)
  expect(await inspect(input)).toEqual(safe)
  expect(mocks.inspect).toHaveBeenCalledWith({
    ...input.parsedInput,
    workspaceId: "workspace",
    accountId: "account",
  })
})
