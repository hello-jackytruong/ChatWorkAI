// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest"

type ActionArgs = {
  bindArgsParsedInputs: string[]
  parsedInput: Record<string, unknown>
  ctx: {
    workspace: { id: string; scheduledDeletionAt: Date | null }
    workspaceMember: { id: string }
    user: { id: string }
  }
}
type Handler = (args: ActionArgs) => Promise<unknown>
const m = vi.hoisted(() => ({
  access: vi.fn(),
  scope: vi.fn(),
  saved: vi.fn(),
  file: vi.fn(),
  hide: vi.fn(),
  native: vi.fn(),
}))
vi.mock("@chatbotx.io/business", () => ({
  isWorkspaceScheduledForDeletion: (workspace: {
    scheduledDeletionAt: Date | null
  }) => workspace.scheduledDeletionAt !== null,
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountMessageRecallService: {
    getSavedContent: m.saved,
    getSavedAttachment: m.file,
    hideLocally: m.hide,
  },
  zaloAccountMessageOperationsService: {
    recall: m.native,
    deleteOnZalo: m.native,
    deleteChatOnZalo: m.native,
  },
}))
vi.mock("@/lib/public-api/member-scope", () => ({
  assertConversationAccessForCaller: m.access,
  conversationScopeForCaller: m.scope,
}))
vi.mock("@/lib/safe-action", () => ({
  workspaceActionClientAllowExpired: {
    use: (
      middleware: (args: {
        ctx: ActionArgs["ctx"]
        next: (args: { ctx: ActionArgs["ctx"] }) => Promise<unknown>
      }) => Promise<unknown>,
    ) => ({
      bindArgsSchemas: () => ({
        inputSchema: () => ({
          action: (handler: Handler) => async (args: ActionArgs) =>
            await middleware({
              ctx: args.ctx,
              next: async () => await handler(args),
            }),
        }),
      }),
    }),
  },
}))
const actions = await import(
  "../src/features/zalo-accounts/actions/message-operations.action"
)
const args = (): ActionArgs => ({
  bindArgsParsedInputs: ["1", "2", "3"],
  parsedInput: {
    messageId: "4",
    createdAt: new Date("2026-11-23"),
    operation: "hide",
    commandId: "stable-request",
  },
  ctx: {
    workspace: { id: "1", scheduledDeletionAt: null },
    workspaceMember: { id: "5" },
    user: { id: "6" },
  },
})
beforeEach(() => {
  vi.clearAllMocks()
  m.access.mockResolvedValue(undefined)
  m.scope.mockResolvedValue({ chatScope: "assigned" })
  m.saved.mockResolvedValue({ text: "authorized saved content" })
})
const invoke = (action: unknown, input: ActionArgs) =>
  (action as Handler)(input)
test("private original read resolves the same conversation scope before the shared service", async () => {
  const input = args()
  expect(await invoke(actions.getZaloSavedContentAction, input)).toEqual({
    text: "authorized saved content",
  })
  expect(m.access).toHaveBeenCalledWith(
    expect.objectContaining({ workspace: input.ctx.workspace }),
    "3",
  )
  expect(m.saved).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "1",
      accountId: "2",
      conversationId: "3",
      messageId: "4",
      actorUserId: "6",
      scope: { chatScope: "assigned" },
    }),
  )
  expect(m.access.mock.invocationCallOrder[0]).toBeLessThan(
    m.saved.mock.invocationCallOrder[0] ?? 0,
  )
})
test("lost conversation access denies saved files before their service can issue a URL", async () => {
  m.access.mockRejectedValue(new Error("outside scope"))
  await expect(
    invoke(actions.getZaloSavedAttachmentAction, args()),
  ).rejects.toThrow("outside scope")
  expect(m.file).not.toHaveBeenCalled()
})
test.each([
  "getZaloSavedContentAction",
  "getZaloSavedAttachmentAction",
  "mutateZaloMessageAction",
] as const)("scheduled deletion blocks %s before ACL, original read or provider call", async (name) => {
  const input = args()
  input.ctx.workspace.scheduledDeletionAt = new Date()
  await expect(invoke(actions[name], input)).rejects.toThrow(
    "Workspace deletion scheduled",
  )
  expect(m.access).not.toHaveBeenCalled()
  expect(m.saved).not.toHaveBeenCalled()
  expect(m.file).not.toHaveBeenCalled()
  expect(m.native).not.toHaveBeenCalled()
})
test("private local hide uses retained service without a native operation", async () => {
  expect(await invoke(actions.mutateZaloMessageAction, args())).toEqual({
    status: "applied",
  })
  expect(m.hide).toHaveBeenCalledWith(
    expect.objectContaining({
      messageId: "4",
      actorUserId: "6",
      scope: { chatScope: "assigned" },
    }),
  )
  expect(m.native).not.toHaveBeenCalled()
})
