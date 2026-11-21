import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  sync: vi.fn(),
  policy: vi.fn(),
  labels: vi.fn(),
  send: vi.fn(),
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
  },
  zaloAccountLabelService: { sync: mocks.labels },
}))
vi.mock("@chatbotx.io/business/zalo-account/canonical-send", () => ({
  zaloAccountCanonicalSendService: { send: mocks.send },
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
