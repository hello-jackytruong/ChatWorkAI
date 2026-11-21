import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  group: vi.fn(),
  anchor: vi.fn(),
  validate: vi.fn(),
  tags: vi.fn(),
  link: vi.fn(),
  detach: vi.fn(),
  attachSync: vi.fn(),
  detachSync: vi.fn(),
}))
vi.mock("../src/zalo-account/group.service", () => ({
  zaloAccountGroupService: {
    get: mocks.group,
    validateAudience: mocks.validate,
  },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  contactInboxRepository: { findFullByIdForWorkspace: mocks.anchor },
}))
vi.mock("../src/tag/service", () => ({
  tagService: {
    upsertByNames: mocks.tags,
    linkTagToContactsReturningNewUnscoped: mocks.link,
    detachTagFromContactsUnscoped: mocks.detach,
  },
}))
vi.mock("../src/tag/sync.service", () => ({
  tagSyncService: {
    enqueueAttach: mocks.attachSync,
    enqueueDetach: mocks.detachSync,
  },
}))
const { zaloAccountGroupTagService } = await import(
  "../src/zalo-account/group-tag.service"
)
const audience = {
  workspaceId: "w1",
  accountId: "a1",
  groupId: "g1",
  contactInboxId: "ci1",
  conversationId: "cv1",
} as never
beforeEach(() => {
  vi.clearAllMocks()
  mocks.validate.mockResolvedValue(true)
  mocks.group.mockResolvedValue({
    accessible: true,
    contactInboxId: "ci1",
    conversationId: "cv1",
  })
  mocks.anchor.mockResolvedValue({
    id: "ci1",
    contactId: "anchor1",
    contactKind: "channelGroup",
  })
  mocks.tags.mockResolvedValue([{ id: "t1" }])
})
it("tags only the resolved group anchor and uses native sync without customer events", async () => {
  await zaloAccountGroupTagService.update({
    workspaceId: "w1",
    accountId: "a1",
    groupId: "g1",
    names: ["VIP"],
    assigned: true,
    audience,
  })
  expect(mocks.link).toHaveBeenCalledWith({
    tagId: "t1",
    contactIds: ["anchor1"],
  })
  expect(mocks.attachSync).toHaveBeenCalledWith({
    workspaceId: "w1",
    tagId: "t1",
    contactId: "anchor1",
  })
})
it("rejects a changed audience before any tag write", async () => {
  mocks.validate.mockResolvedValue(false)
  await expect(
    zaloAccountGroupTagService.update({
      workspaceId: "w1",
      accountId: "a1",
      groupId: "g1",
      names: ["VIP"],
      assigned: false,
      audience,
    }),
  ).rejects.toThrow()
  expect(mocks.tags).not.toHaveBeenCalled()
  expect(mocks.detachSync).not.toHaveBeenCalled()
})
