const LABEL_WRITE_COMMAND_PATTERN = /^zalo-labels-write-[a-f0-9]{64}$/
const LABEL_HASH_PATTERN = /^[a-f0-9]{64}$/

import { ZaloAccountPreDispatchError } from "@chatbotx.io/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"

const versionConflict = () =>
  new ZaloAccountPreDispatchError("Zalo Account label version conflict", {
    code: "label_version_conflict",
    phase: "validation",
    safeAction: "new_attempt",
  })

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
  listNamedMappings: vi.fn(),
  insertMappingPreservingIdentity: vi.fn(),
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
    insertMappingPreservingIdentity: mocks.insertMappingPreservingIdentity,
    listByIntegration: mocks.listMappings,
    listNamedByIntegration: mocks.listNamedMappings,
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

const scope = { workspaceId: account.workspaceId, accountId: account.id }

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
    vi.stubEnv("ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS", undefined)
    mocks.findAccount.mockResolvedValue(account)
    mocks.state = { version: 0, complete: false }
    mocks.groups.mockResolvedValue([{ providerGroupId: "group-1" }])
    mocks.listMappings.mockResolvedValue([])
    mocks.listNamedMappings.mockResolvedValue([])
    mocks.listAssignmentPage.mockResolvedValue([])
    mocks.findMapping.mockResolvedValue(undefined)
    mocks.ensureTagByName.mockResolvedValue("tag-1")
    mocks.ensureTagChannel.mockResolvedValue("tag-channel-1")
    mocks.insertMappingPreservingIdentity.mockResolvedValue({
      id: "tag-channel-1",
      tagId: "tag-1",
    })
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
      .mockRejectedValueOnce(versionConflict())
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

  it("edits only one label definition against a fresh whole document after a conflict", async () => {
    vi.stubEnv(
      "ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS",
      "another-account, account-1",
    )
    const initial = label({ id: 1 })
    const latest = { ...initial, conversations: ["new-DM", "new-group"] }
    const untouched = label({
      id: 2,
      text: "Other",
      textKey: "untouched",
      offset: 7,
      color: "0068FF",
      emoji: "💬",
      createTime: 2,
      conversations: ["different-DM", "different-group"],
    })
    const expected = {
      ...latest,
      text: "New name",
      color: "#aabbcc",
      emoji: "",
    }
    mocks.getLabels
      .mockResolvedValueOnce({
        labelData: [initial, untouched],
        version: 7,
        lastUpdateTime: 30,
        complete: true,
      })
      .mockResolvedValueOnce({
        labelData: [latest, untouched],
        version: 8,
        lastUpdateTime: 31,
        complete: true,
      })
    mocks.updateLabels
      .mockRejectedValueOnce(versionConflict())
      .mockResolvedValueOnce({
        labelData: [expected, untouched],
        version: 9,
        lastUpdateTime: 32,
        complete: true,
      })
    await expect(
      zaloAccountLabelService.updateDefinition({
        ...scope,
        commandId: "rename-1",
        labelId: 1,
        patch: { text: " New name ", color: "#AABBCC", emoji: "" },
      }),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      version: 9,
      label: { id: 1, text: "New name", color: "#aabbcc", emoji: "" },
    })
    expect(mocks.updateLabels).toHaveBeenCalledTimes(2)
    expect(mocks.updateLabels).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedVersion: 8,
        expectedHash: expect.stringMatching(LABEL_HASH_PATTERN),
        labelData: [expected, untouched],
      }),
    )
    expect(mocks.linkAssignments).not.toHaveBeenCalled()
    expect(mocks.syncName).not.toHaveBeenCalled()
  })

  it.each([
    "false",
    "another-account",
  ])("leaves native edits unavailable when account configuration %s excludes the account", async (configuration) => {
    vi.stubEnv("ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS", configuration)
    await expect(
      zaloAccountLabelService.updateDefinition({
        ...scope,
        commandId: "disabled",
        labelId: 1,
        patch: { text: "New label" },
      }),
    ).resolves.toEqual({ outcome: "unavailable" })
    expect(mocks.getLabels).not.toHaveBeenCalled()
    expect(mocks.updateLabels).not.toHaveBeenCalled()
  })

  it("checks the definition gate and expected base hash again at dispatch", async () => {
    vi.stubEnv("ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS", "false")
    const state = {
      token: "current",
      version: 8,
      hash: "base-hash",
      commandId: "write-current",
      reason: "mutationPending",
      mutationKind: "definition",
    }
    mocks.findAccount.mockResolvedValue({
      ...account,
      operations: { labels: state },
    })
    const input = {
      ...scope,
      inboxId: account.inboxId,
      operationToken: state.token,
      commandId: state.commandId,
      expectedVersion: state.version,
      expectedHash: state.hash,
    }
    await expect(zaloAccountLabelService.admitMutation(input)).rejects.toThrow()
    vi.stubEnv("ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS", account.id)
    await expect(
      zaloAccountLabelService.admitMutation({
        ...input,
        expectedHash: "other",
      }),
    ).rejects.toThrow()
    await expect(
      zaloAccountLabelService.admitMutation(input),
    ).resolves.toBeUndefined()
  })

  it("does not pause definitions as unknown for a known rejection before provider dispatch", async () => {
    vi.stubEnv("ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS", account.id)
    mocks.getLabels.mockResolvedValue({
      labelData: [label()],
      version: 8,
      lastUpdateTime: 31,
      complete: true,
    })
    mocks.updateLabels.mockRejectedValueOnce(
      new ZaloAccountPreDispatchError("disabled before dispatch"),
    )
    await expect(
      zaloAccountLabelService.updateDefinition({
        ...scope,
        commandId: "gate-withdrawn",
        labelId: 1,
        patch: { text: "Changed" },
      }),
    ).resolves.toEqual({ outcome: "unavailable", version: 8 })
    expect(mocks.state).toMatchObject({
      paused: false,
      pendingHash: undefined,
      mutationKind: undefined,
    })
    expect(mocks.updateLabels).toHaveBeenCalledOnce()
  })

  it("does not confirm a provider response that changed unrelated assignments", async () => {
    vi.stubEnv("ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS", account.id)
    mocks.getLabels.mockResolvedValue({
      labelData: [label(), label({ id: 2 })],
      version: 8,
      lastUpdateTime: 31,
      complete: true,
    })
    mocks.updateLabels.mockResolvedValue({
      labelData: [
        label({ text: "Changed" }),
        label({ id: 2, conversations: [] }),
      ],
      version: 9,
      lastUpdateTime: 32,
      complete: true,
    })
    await expect(
      zaloAccountLabelService.updateDefinition({
        ...scope,
        commandId: "race",
        labelId: 1,
        patch: { text: "Changed" },
      }),
    ).resolves.toMatchObject({ outcome: "unknown" })
    expect(mocks.updateLabels).toHaveBeenCalledOnce()
    expect(mocks.state).toMatchObject({
      paused: true,
      reason: "outcomeUnknown",
    })
    expect(mocks.linkAssignments).not.toHaveBeenCalled()
  })

  it("lists safe native definitions by provider order with only ID-scoped mappings", async () => {
    const lastSuccessAt = "2026-11-28T11:11:00.000Z"
    mocks.findAccount.mockResolvedValueOnce({
      ...account,
      operations: { labels: { version: 6, complete: true, lastSuccessAt } },
    })
    mocks.getLabels.mockResolvedValue({
      labelData: [
        label({ id: 1, offset: 10, color: "evil()" }),
        label({ id: 2, offset: 1, color: "AABBCC" }),
      ],
      version: 6,
      lastUpdateTime: 30,
      complete: true,
    })
    mocks.listNamedMappings.mockResolvedValueOnce([
      { externalLabelId: "2", tagId: "tag-2", tagName: "CRM name" },
    ])
    await expect(zaloAccountLabelService.listNative(scope)).resolves.toEqual({
      available: true,
      complete: true,
      version: 6,
      editEnabled: true,
      lastSuccessAt,
      labels: [
        {
          id: 2,
          text: "Priority",
          color: "#aabbcc",
          emoji: "",
          offset: 1,
          tagId: "tag-2",
          tagName: "CRM name",
        },
        { id: 1, text: "Priority", emoji: "", offset: 10 },
      ],
    })
    expect(mocks.listNamedMappings).toHaveBeenCalledWith({
      externalLabelIds: ["1", "2"],
      workspaceId: account.workspaceId,
      integrationId: account.id,
      channelType: "zaloAccount",
    })
  })

  it("keeps a same-name tag's established provider identity and leaves the new label unmapped", async () => {
    mocks.getLabels.mockResolvedValue({
      labelData: [label({ id: 2 })],
      version: 8,
      lastUpdateTime: 30,
      complete: true,
    })
    mocks.insertMappingPreservingIdentity.mockResolvedValueOnce(undefined)
    await zaloAccountLabelService.sync({ ...scope, commandId: "same-name" })
    expect(mocks.insertMappingPreservingIdentity).toHaveBeenCalledWith(
      {
        workspaceId: account.workspaceId,
        integrationId: account.id,
        channelType: "zaloAccount",
        tagId: "tag-1",
        externalLabelId: "2",
      },
      expect.anything(),
    )
    expect(mocks.ensureTagChannel).not.toHaveBeenCalled()
    expect(mocks.linkContacts).not.toHaveBeenCalled()
  })

  it("advances the successful sync time only after the last completely reconciled batch", async () => {
    const previous = "2026-11-28T10:00:00.000Z"
    mocks.state = { version: 4, complete: true, lastSuccessAt: previous }
    mocks.getLabels.mockResolvedValue({
      labelData: Array.from({ length: 11 }, (_, index) =>
        label({ id: index + 1, offset: index }),
      ),
      version: 5,
      lastUpdateTime: 20,
      complete: true,
    })
    await zaloAccountLabelService.sync({ ...scope, commandId: "first-batch" })
    expect(mocks.state.lastSuccessAt).toBe(previous)
    await zaloAccountLabelService.sync({ ...scope, commandId: "last-batch" })
    expect(mocks.state.lastSuccessAt).not.toBe(previous)
    expect(typeof mocks.state.lastSuccessAt).toBe("string")
  })
})
