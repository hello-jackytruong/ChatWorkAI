import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ validate: vi.fn(), handler: vi.fn() }))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountGroupService: { validateAudience: mocks.validate },
}))
vi.mock("../src/trigger/services/actions/registry", () => ({
  resolveTriggerActionHandler: () => mocks.handler,
}))
vi.mock("../src/trigger/services/actions/scope", () => ({
  createTriggerActionScope: vi.fn(),
}))
const { ActionExecutor } = await import(
  "../src/trigger/services/action-executor"
)
const audience = {
  workspaceId: "w1",
  conversationId: "cv1",
  contactInboxId: "ci1",
}
const scope = {
  getConversation: async () => ({
    id: "cv1",
    workspaceId: "w1",
    sourceId: "za:group:g1",
  }),
  getContactInbox: async () => ({ id: "ci1", contactKind: "channelGroup" }),
} as never
beforeEach(() => {
  vi.clearAllMocks()
  mocks.validate.mockResolvedValue(true)
  mocks.handler.mockResolvedValue({ status: "succeeded" })
})
it("denies every customer action for a group even with a valid audience", async () => {
  await expect(
    new ActionExecutor().execute(
      {
        workspaceId: "w1",
        action: { type: "setCustomField" },
        groupAudience: audience,
      } as never,
      scope,
    ),
  ).resolves.toEqual({ status: "skipped", reason: "unsupportedGroupAction" })
  expect(mocks.handler).not.toHaveBeenCalled()
})
it("requires matching current audience before a permitted group tag action", async () => {
  const executor = new ActionExecutor()
  const base = {
    workspaceId: "w1",
    action: { type: "addTag" },
    groupAudience: audience,
  }
  await executor.execute(base as never, scope)
  expect(mocks.handler).toHaveBeenCalledTimes(1)
  mocks.validate.mockResolvedValue(false)
  await executor.execute(base as never, scope)
  await executor.execute({ ...base, groupAudience: undefined } as never, scope)
  expect(mocks.handler).toHaveBeenCalledTimes(1)
})
