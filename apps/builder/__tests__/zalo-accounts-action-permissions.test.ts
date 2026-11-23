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
