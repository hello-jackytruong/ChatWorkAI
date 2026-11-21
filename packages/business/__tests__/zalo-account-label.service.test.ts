const LABEL_WRITE_COMMAND_PATTERN = /^zalo-labels-write-[a-f0-9]{64}$/

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
  state: { version: 0, complete: false } as Record<string, unknown>,
  lock: vi.fn(async ({ fn }) => await fn()),
}))
vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: { runExclusive: mocks.lock },
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountRepository: {
    claimLabelOperation: vi.fn(({ token }) => {
      mocks.state = { ...mocks.state, token }
      return Promise.resolve(mocks.state)
    }),
    withLabelFence: vi.fn(async (_input, fn) => {
      mocks.state = await fn({}, mocks.state)
      return mocks.state
    }),
  },
  contactInboxRepository: {
    listContactIdsByIds: mocks.listContactIds,
    listIdsByInboxAndSourceIds: mocks.listInboxes,
  },
  integrationZaloAccountGroupRepository: { list: mocks.groups },
  tagChannelRepository: {
    findByTagAndIntegration: mocks.findMappingByTag,
    listByIntegration: mocks.listMappings,
    listContactInboxIdsForChannelPage: mocks.listAssignmentPage,
    listUnmappedContactIds: vi.fn().mockResolvedValue([]),
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
  it("fences an expired mutation owner before provider admission", async () => {
    mocks.findAccount.mockResolvedValue({
      ...account,
      operations: {
        labels: {
          token: "current",
          version: 7,
          commandId: "write-current",
          reason: "mutationPending",
        },
      },
    })
    await expect(
      zaloAccountLabelService.admitMutation({
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        operationToken: "expired",
        expectedVersion: 7,
        commandId: "write-current",
      }),
    ).rejects.toThrow("Stale Zalo label operation")
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findAccount.mockResolvedValue(account)
    mocks.state = { version: 0, complete: false }
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

  it("maps direct and group threads through the owning account Inbox", async () => {
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
      sourceIds: ["user-1", "za:group:group-1"],
    })
    expect(mocks.linkAssignments).toHaveBeenCalledWith(
      expect.objectContaining({
        tagId: "tag-1",
        tagChannelId: "tag-channel-1",
        contactInboxIds: ["contact-inbox-1"],
      }),
    )
  })
  it("never detaches from a nonempty completeness-unknown snapshot", async () => {
    mocks.getLabels.mockResolvedValue({
      labelData: [label()],
      version: 4,
      lastUpdateTime: 20,
    })
    mocks.listAssignmentPage.mockResolvedValue([{ contactInboxId: "missing" }])
    await zaloAccountLabelService.sync({
      workspaceId: "workspace-1",
      accountId: "account-1",
      commandId: "partial",
    })
    expect(mocks.deleteAssignments).not.toHaveBeenCalled()
    expect(mocks.enqueueDelete).not.toHaveBeenCalled()
  })
  it("resumes bounded positive reconciliation even for a partial snapshot", async () => {
    mocks.getLabels.mockResolvedValue({
      labelData: Array.from({ length: 12 }, (_, index) =>
        label({ id: index + 1, text: `Label ${index}` }),
      ),
      version: 4,
      lastUpdateTime: 20,
    })
    const input = {
      workspaceId: "workspace-1",
      accountId: "account-1",
      commandId: "partial-pages",
    }
    await zaloAccountLabelService.sync(input)
    await zaloAccountLabelService.sync(input)
    expect(
      mocks.findMapping.mock.calls.map(([scope]) => scope.externalLabelId),
    ).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)))
    expect(mocks.deleteAssignments).not.toHaveBeenCalled()
  })
  it("does not lower an accepted version or apply a stale pull", async () => {
    mocks.state = { version: 10, complete: true }
    mocks.getLabels.mockResolvedValue({
      labelData: [label()],
      version: 9,
      lastUpdateTime: 20,
      complete: true,
    })
    await zaloAccountLabelService.sync({
      workspaceId: "workspace-1",
      accountId: "account-1",
      commandId: "stale",
    })
    expect(mocks.linkContacts).not.toHaveBeenCalled()
    expect(mocks.state.version).toBe(10)
  })
  it("persists uncertainty and pauses writes without accepting a provider mapping", async () => {
    mocks.findMappingByTag.mockResolvedValue({
      id: "tag-channel-1",
      externalLabelId: "1",
    })
    mocks.getLabels.mockResolvedValue({
      labelData: [label({ conversations: [] })],
      version: 7,
      lastUpdateTime: 30,
      complete: true,
    })
    mocks.updateLabels.mockRejectedValue(new Error("outcome is unknown"))
    const input = {
      workspaceId: "workspace-1",
      accountId: "account-1",
      contactInboxId: "contact-inbox-1",
      sourceId: "user-1",
      tagId: "tag-1",
      assigned: true,
      commandId: "unknown",
    }
    await expect(
      zaloAccountLabelService.mutateAssignment(input),
    ).rejects.toThrow("unknown")
    expect(mocks.linkAssignments).not.toHaveBeenCalled()
    expect(mocks.state).toMatchObject({
      paused: true,
      reason: "outcomeUnknown",
      commandId: expect.stringMatching(LABEL_WRITE_COMMAND_PATTERN),
    })
    await expect(
      zaloAccountLabelService.mutateAssignment(input),
    ).rejects.toThrow("paused")
    expect(mocks.updateLabels).toHaveBeenCalledTimes(1)
    await zaloAccountLabelService.sync({ ...input, commandId: "reconcile" })
    expect(mocks.state.paused).toBe(true)
    mocks.getLabels.mockResolvedValue({
      labelData: [label({ conversations: ["user-1"] })],
      version: 8,
      lastUpdateTime: 31,
      complete: true,
    })
    await zaloAccountLabelService.sync({
      ...input,
      commandId: "reconcile-accepted",
    })
    expect(mocks.state.paused).toBe(false)
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
      complete: true,
    })
    mocks.updateLabels.mockResolvedValue({
      labelData: [
        label({ conversations: ["user-1"] }),
        label({ id: 2, text: "Other", conversations: ["other-user"] }),
      ],
      version: 8,
      lastUpdateTime: 31,
      complete: true,
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
        complete: true,
      })
      .mockResolvedValueOnce({
        labelData: [label({ conversations: ["other-user"] })],
        version: 8,
        lastUpdateTime: 31,
        complete: true,
      })
    mocks.updateLabels
      .mockRejectedValueOnce(new Error("Zalo Account label version conflict"))
      .mockResolvedValueOnce({
        labelData: [label({ conversations: ["other-user", "user-1"] })],
        version: 9,
        lastUpdateTime: 32,
        complete: true,
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
