import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  deleteAssignments: vi.fn(),
  detachContacts: vi.fn(),
  enqueueDelete: vi.fn(),
  ensureTagByName: vi.fn(),
  ensureTagChannel: vi.fn(),
  findAccount: vi.fn(),
  findMapping: vi.fn(),
  findMappingByTag: vi.fn(),
  findTag: vi.fn(),
  getLabels: vi.fn(),
  groups: vi.fn(),
  linkAssignments: vi.fn(),
  linkContacts: vi.fn(),
  listAssignmentPage: vi.fn(),
  listContactIds: vi.fn(),
  listInboxes: vi.fn(),
  listMappings: vi.fn(),
  syncName: vi.fn(),
  unlinkContactInbox: vi.fn(),
  updateLabels: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  contactInboxRepository: {
    listContactIdsByIds: mocks.listContactIds,
    listIdsByInboxAndSourceIds: mocks.listInboxes,
  },
  integrationZaloAccountGroupRepository: { list: mocks.groups },
  tagChannelRepository: {
    findByTagAndIntegration: mocks.findMappingByTag,
    listByIntegration: mocks.listMappings,
    listContactInboxIdsForChannelPage: mocks.listAssignmentPage,
  },
}))
vi.mock("../src/tag/service", () => ({
  tagService: {
    deleteTagChannelAssignmentsUnscoped: mocks.deleteAssignments,
    detachTagFromContactsUnscoped: mocks.detachContacts,
    ensureTagByName: mocks.ensureTagByName,
    ensureTagChannel: mocks.ensureTagChannel,
    findById: mocks.findTag,
    findTagChannel: mocks.findMapping,
    linkTagToContactsReturningNewUnscoped: mocks.linkContacts,
    recordTagChannelAssignmentsUnscoped: mocks.linkAssignments,
    syncNameFromChannel: mocks.syncName,
  },
}))
vi.mock("../src/tag/sync.service", () => ({
  tagSyncService: {
    enqueueDelete: mocks.enqueueDelete,
    linkContactInbox: mocks.linkAssignments,
    unlinkContactInbox: mocks.unlinkContactInbox,
  },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.findAccount },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    getLabelsAndWait: mocks.getLabels,
    updateLabelsAndWait: mocks.updateLabels,
  },
}))

const { zaloAccountLabelService } = await import(
  "../src/zalo-account/label.service"
)

const account = {
  id: "account-1",
  workspaceId: "workspace-1",
  inboxId: "inbox-1",
}

const label = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  text: "Priority",
  textKey: "priority",
  conversations: ["user-1", "group-1"],
  color: "#0068FF",
  offset: 0,
  emoji: "",
  createTime: 1,
  ...overrides,
})

describe("zaloAccountLabelService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findAccount.mockResolvedValue(account)
    mocks.groups.mockResolvedValue([{ providerGroupId: "group-1" }])
    mocks.listMappings.mockResolvedValue([])
    mocks.listAssignmentPage.mockResolvedValue([])
    mocks.findMapping.mockResolvedValue(undefined)
    mocks.ensureTagByName.mockResolvedValue("tag-1")
    mocks.ensureTagChannel.mockResolvedValue("tag-channel-1")
    mocks.listInboxes.mockResolvedValue([
      { id: "contact-inbox-1", contactId: "contact-1", sourceId: "user-1" },
    ])
    mocks.listContactIds.mockResolvedValue([])
  })

  it("does not apply destructive reconciliation from an empty snapshot", async () => {
    mocks.getLabels.mockResolvedValue({
      labelData: [],
      version: 3,
      lastUpdateTime: 10,
    })

    await expect(
      zaloAccountLabelService.sync({
        workspaceId: "workspace-1",
        accountId: "account-1",
        commandId: "sync-1",
      }),
    ).resolves.toEqual({
      version: 3,
      labelCount: 0,
      destructiveDiffApplied: false,
    })
    expect(mocks.listMappings).not.toHaveBeenCalled()
    expect(mocks.enqueueDelete).not.toHaveBeenCalled()
  })

  it("maps definitions and assignments only for direct contacts", async () => {
    mocks.getLabels.mockResolvedValue({
      labelData: [label()],
      version: 4,
      lastUpdateTime: 20,
    })

    await zaloAccountLabelService.sync({
      workspaceId: "workspace-1",
      accountId: "account-1",
      commandId: "sync-2",
    })

    expect(mocks.listInboxes).toHaveBeenCalledWith({
      inboxId: "inbox-1",
      sourceIds: ["user-1"],
    })
    expect(mocks.linkAssignments).toHaveBeenCalledWith({
      tagId: "tag-1",
      tagChannelId: "tag-channel-1",
      contactInboxIds: ["contact-inbox-1"],
    })
  })

  it("preserves unrelated labels when attaching and persists only after acceptance", async () => {
    mocks.findMappingByTag.mockResolvedValue({
      id: "tag-channel-1",
      externalLabelId: "1",
    })
    mocks.getLabels.mockResolvedValue({
      labelData: [
        label({ conversations: [] }),
        label({ id: 2, text: "Other", conversations: ["other-user"] }),
      ],
      version: 7,
      lastUpdateTime: 30,
    })
    mocks.updateLabels.mockResolvedValue({
      labelData: [],
      version: 8,
      lastUpdateTime: 31,
    })

    await expect(
      zaloAccountLabelService.mutateAssignment({
        workspaceId: "workspace-1",
        accountId: "account-1",
        contactInboxId: "contact-inbox-1",
        sourceId: "user-1",
        tagId: "tag-1",
        assigned: true,
        commandId: "attach-1",
      }),
    ).resolves.toBe(true)

    expect(mocks.updateLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 7,
        labelData: [
          expect.objectContaining({ id: 1, conversations: ["user-1"] }),
          expect.objectContaining({ id: 2, conversations: ["other-user"] }),
        ],
      }),
    )
    expect(
      mocks.linkAssignments.mock.invocationCallOrder.at(-1),
    ).toBeGreaterThan(mocks.updateLabels.mock.invocationCallOrder.at(-1) ?? 0)
  })

  it("refreshes once on a verified version conflict", async () => {
    mocks.findMappingByTag.mockResolvedValue({
      id: "tag-channel-1",
      externalLabelId: "1",
    })
    mocks.getLabels
      .mockResolvedValueOnce({
        labelData: [label({ conversations: [] })],
        version: 7,
        lastUpdateTime: 30,
      })
      .mockResolvedValueOnce({
        labelData: [label({ conversations: ["other-user"] })],
        version: 8,
        lastUpdateTime: 31,
      })
    mocks.updateLabels
      .mockRejectedValueOnce(new Error("Zalo Account label version conflict"))
      .mockResolvedValueOnce({
        labelData: [],
        version: 9,
        lastUpdateTime: 32,
      })

    await zaloAccountLabelService.mutateAssignment({
      workspaceId: "workspace-1",
      accountId: "account-1",
      contactInboxId: "contact-inbox-1",
      sourceId: "user-1",
      tagId: "tag-1",
      assigned: true,
      commandId: "attach-conflict",
    })

    expect(mocks.getLabels).toHaveBeenCalledTimes(2)
    expect(mocks.updateLabels).toHaveBeenCalledTimes(2)
    expect(mocks.updateLabels).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedVersion: 8,
        labelData: [
          expect.objectContaining({
            conversations: ["other-user", "user-1"],
          }),
        ],
      }),
    )
  })
})
