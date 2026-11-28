import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  assertConversation: vi.fn(),
  allowPhone: vi.fn(),
  get: vi.fn(),
  findInbox: vi.fn(),
  findAccount: vi.fn(),
}))
vi.mock("@chatbotx.io/business", () => ({
  contactInboxService: { findByIdForWorkspace: mocks.findInbox },
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
  zaloAccountProfileService: { get: mocks.get },
  zaloAccountService: { findByInboxId: mocks.findAccount },
}))
vi.mock("@chatbotx.io/business/workspace-member/permissions", () => ({
  hasWorkspacePermission: mocks.allowPhone,
}))

const { getZaloProfileAction } = await import(
  "@/features/zalo-accounts/actions/profile.action"
)
const load = getZaloProfileAction as unknown as (
  input: unknown,
) => Promise<unknown>
const input = {
  bindArgsParsedInputs: ["1", "2"],
  ctx: {
    workspace: { id: "1" },
    user: { id: "5" },
    workspaceMember: { userId: "5", permissions: {} },
  },
  parsedInput: {
    conversationId: "3",
    contactInboxId: "4",
    memberUid: "provider-user",
    refresh: true,
  },
}

beforeEach(() => vi.resetAllMocks())

it("cannot refresh a member profile outside the caller's conversation scope", async () => {
  mocks.assertConversation.mockRejectedValue(new Error("forbidden"))
  await expect(load(input)).rejects.toThrow("forbidden")
  expect(mocks.get).not.toHaveBeenCalled()
})

it("passes the exact authorized provider target and masks phone when the caller lacks phone permission", async () => {
  mocks.get.mockResolvedValue({
    profile: {
      uid: "provider-user",
      fields: { zaloName: "Khanh", publicPhone: "0123456789" },
    },
    staleness: "fresh",
  })
  expect(await load(input)).toEqual({
    profile: { uid: "provider-user", fields: { zaloName: "Khanh" } },
    staleness: "fresh",
  })
  expect(mocks.get).toHaveBeenCalledWith({
    workspaceId: "1",
    accountId: "2",
    ...input.parsedInput,
  })
  expect(mocks.allowPhone).toHaveBeenCalledWith({}, "emailAndPhone")
})

it("resolves the authorized direct contact's account without requiring a saved message", async () => {
  mocks.assertConversation.mockResolvedValue({ contactId: "9" })
  mocks.findInbox.mockResolvedValue({
    channel: "zaloAccount",
    contactKind: "person",
    contactId: "9",
    inboxId: "6",
  })
  mocks.findAccount.mockResolvedValue({ id: "7" })
  mocks.get.mockResolvedValue({ profile: null, staleness: "unavailable" })
  const direct = { conversationId: "3", contactInboxId: "4", refresh: false }
  await expect(
    load({ ...input, bindArgsParsedInputs: ["1", null], parsedInput: direct }),
  ).resolves.toMatchObject({ profile: null })
  expect(mocks.findAccount).toHaveBeenCalledWith({
    workspaceId: "1",
    inboxId: "6",
  })
  expect(mocks.get).toHaveBeenCalledWith({
    workspaceId: "1",
    accountId: "7",
    ...direct,
  })
})
