import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  assertConversation: vi.fn(),
  requireWorkspace: vi.fn(),
  status: vi.fn(),
  start: vi.fn(),
  resume: vi.fn(),
}))
vi.mock("@/lib/auth/require-workspace-permission", () => ({
  requireWorkspacePermission: mocks.requireWorkspace,
}))
vi.mock("@/lib/public-api/member-scope", () => ({
  assertConversationAccessForCaller: mocks.assertConversation,
}))
vi.mock("@/lib/safe-action", () => ({
  workspaceActionClient: {
    bindArgsSchemas() {
      return this
    },
    inputSchema() {
      return this
    },
    action(handler: unknown) {
      return handler
    },
  },
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  isZaloAccountHistorySyncEnabled: () => true,
  zaloAccountHistorySyncService: {
    status: mocks.status,
    start: mocks.start,
    resume: mocks.resume,
  },
}))

const {
  getZaloHistorySyncStatusAction,
  startZaloHistorySyncAction,
  resumeZaloHistorySyncAction,
} = await import("@/features/zalo-accounts/actions/history-sync.action")

const context = {
  workspace: { id: "1" },
  workspaceMember: { userId: "8", permissions: {} },
  user: { id: "8" },
}
const actionArgs = {
  bindArgsParsedInputs: ["1", "2"],
  ctx: context,
}

beforeEach(() => {
  vi.resetAllMocks()
})

it("checks account management permission before reading a checkpoint or making any sync request", async () => {
  mocks.requireWorkspace.mockRejectedValue(new Error("forbidden"))
  for (const action of [
    getZaloHistorySyncStatusAction,
    startZaloHistorySyncAction,
    resumeZaloHistorySyncAction,
  ]) {
    const call = action as unknown as (input: unknown) => Promise<unknown>
    await expect(call({ ...actionArgs, parsedInput: {} })).rejects.toThrow(
      "forbidden",
    )
  }
  expect(mocks.requireWorkspace).toHaveBeenCalledWith("1", "superAdmin")
  expect(mocks.assertConversation).not.toHaveBeenCalled()
  expect(mocks.status).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.resume).not.toHaveBeenCalled()
})

it("requires conversation access before forwarding the exact scope to the shared history service", async () => {
  const selected = { conversationId: "3", contactInboxId: "4" }
  const resume = resumeZaloHistorySyncAction as unknown as (
    input: unknown,
  ) => Promise<unknown>
  const body = { ...selected, commandId: "command", runId: "5" }
  mocks.assertConversation.mockRejectedValueOnce(new Error("forbidden"))
  await expect(resume({ ...actionArgs, parsedInput: body })).rejects.toThrow(
    "forbidden",
  )
  expect(mocks.resume).not.toHaveBeenCalled()
  mocks.resume.mockResolvedValue({ runId: "5", status: "running" })
  expect(await resume({ ...actionArgs, parsedInput: body })).toMatchObject({
    runId: "5",
  })
  expect(mocks.requireWorkspace).not.toHaveBeenCalled()
  expect(mocks.assertConversation).toHaveBeenCalledWith(
    {
      workspace: context.workspace,
      member: context.workspaceMember,
      user: context.user,
    },
    "3",
  )
  expect(mocks.resume).toHaveBeenCalledWith({
    workspaceId: "1",
    accountId: "2",
    ...body,
  })
})
