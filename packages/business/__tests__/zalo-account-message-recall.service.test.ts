import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  pointer: vi.fn(),
  pointerRows: vi.fn(),
  reconcile: vi.fn(),
  attempt: vi.fn(),
  media: vi.fn(),
  bindMediaAliases: vi.fn(),
  createStable: vi.fn(),
  observed: vi.fn(),
  lock: vi.fn(),
  account: vi.fn(),
  conversation: vi.fn(),
  message: vi.fn(),
  inbox: vi.fn(),
  group: vi.fn(),
  find: vi.fn(),
  batch: vi.fn(),
  audit: vi.fn(),
  head: vi.fn(),
  sign: vi.fn(),
  publish: vi.fn(),
  applied: vi.fn(),
  published: vi.fn(),
  exact: vi.fn(),
  due: vi.fn(),
  defer: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountSendAttemptRepository: { findByProviderMessage: m.attempt },
  zaloAccountMediaRepository: { list: m.media },
  contactInboxRepository: { findFullByIdForWorkspace: m.inbox },
  createMessageRepository: async () => ({
    reconcileOutgoingSourceId: m.reconcile,
    createWithStableIdentity: m.createStable,
    findById: m.message,
    applyZaloAccountLifecycleExact: m.exact,
  }),
  integrationZaloAccountGroupRepository: { findByProviderId: m.group },
  zaloAccountMessageRecallRepository: {
    recordOriginalObserved: m.observed,
    withTargetLock: m.lock,
    bindPointer: m.pointer,
    findForMessages: m.pointerRows,
    findTarget: m.find,
    findTargets: m.batch,
    markApplied: m.applied,
    markPublished: m.published,
    listDue: m.due,
    defer: m.defer,
  },
}))
vi.mock("../src/zalo-account-media/service", () => ({
  zaloAccountMediaService: { bindMessageAliases: m.bindMediaAliases },
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { headObject: m.head, getPresignedDownload: m.sign },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: m.account },
}))
vi.mock("../src/conversation/service", () => ({
  conversationService: { findBy: m.conversation },
}))
vi.mock("../src/conversation/member-scope", () => ({
  conversationMemberScope: {
    allows: (scope: { chatScope: string } | undefined) =>
      scope?.chatScope !== "none",
  },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecordSafely: m.audit,
}))
vi.mock("../src/platform/realtime-broadcast", () => ({
  publishWorkspaceRealtimeEvent: m.publish,
}))
const { zaloAccountMessageRecallService: service } = await import(
  "../src/zalo-account/message-recall.service"
)
const input = {
  workspaceId: "w",
  accountId: "a",
  conversationId: "c",
  messageId: "m",
  messageCreatedAt: new Date("2026-01-01"),
}
const attachment = {
  id: "file",
  workspaceId: "w",
  conversationId: "c",
  messageId: "m",
  originPath: "https://provider/private",
  name: "file",
  mimeType: "image/jpeg",
  size: 12,
}
const row = {
  id: "r",
  workspaceId: "w",
  accountId: "a",
  inboxId: "in",
  threadType: "user",
  threadId: "u",
  providerMessageId: "p",
  groupId: null,
  messageId: "m",
  messageCreatedAt: input.messageCreatedAt,
  contactInboxId: "ci",
  conversationId: "c",
  anchorBoundAt: new Date(),
  recallReceivedAt: new Date(),
  lifecycleRevision: 1,
  originalObservedAt: new Date(),
  retryCount: 0,
}
beforeEach(() => {
  vi.clearAllMocks()
  m.media.mockResolvedValue([])
  m.pointerRows.mockResolvedValue([])
  m.attempt.mockResolvedValue(undefined)
  m.reconcile.mockResolvedValue({ message: { id: "m" }, removedEchoes: [] })
  m.account.mockResolvedValue({ id: "a", inboxId: "in" })
  m.conversation.mockResolvedValue({
    id: "c",
    contactId: "contact",
    workspaceId: "w",
  })
  m.inbox.mockResolvedValue({
    id: "ci",
    inboxId: "in",
    contactId: "contact",
    sourceId: "u",
    contactKind: "person",
  })
  m.message.mockResolvedValue({
    id: "m",
    createdAt: input.messageCreatedAt,
    contactInboxId: "ci",
    sourceId: "za:a:user:u:p",
    text: "original",
    attachments: [attachment],
  })
  m.lock.mockImplementation(async (_input, fn) => await fn({}))
  m.find.mockResolvedValue(null)
  m.audit.mockResolvedValue(undefined)
  m.batch.mockResolvedValue([])
  m.exact.mockResolvedValue({ id: "m" })
  m.applied.mockResolvedValue(row)
  m.publish.mockResolvedValue(undefined)
})
describe("retained original access", () => {
  it("rejects another account before returning content or signing", async () => {
    m.message.mockResolvedValue({
      contactInboxId: "ci",
      sourceId: "za:other:user:u:p",
    })
    await expect(service.getSavedContent(input)).rejects.toThrow()
    expect(m.sign).not.toHaveBeenCalled()
    expect(m.audit).not.toHaveBeenCalled()
  })
  it("does not fetch or sign provider URL only media", async () => {
    expect(
      await service.getSavedAttachment({ ...input, attachmentId: "file" }),
    ).toMatchObject({ availability: "not_archived", url: null })
    expect(m.head).not.toHaveBeenCalled()
    expect(m.sign).not.toHaveBeenCalled()
  })
  it("checks one stored object and issues a short lived link with metadata only audit", async () => {
    m.message.mockResolvedValue({
      ...(await m.message()),
      attachments: [{ ...attachment, originPath: "private/stored" }],
    })
    m.head.mockResolvedValue({})
    m.sign.mockResolvedValue("https://signed/private")
    expect(
      await service.getSavedAttachment({ ...input, attachmentId: "file" }),
    ).toMatchObject({ availability: "stored", url: "https://signed/private" })
    expect(m.head).toHaveBeenCalledTimes(1)
    expect(m.sign).toHaveBeenCalledWith("private/stored", 60)
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain("https://signed")
  })
  it("redacts an embedded quote whose target is outside the page", async () => {
    m.batch.mockResolvedValue([row])
    const [projected] = await service.projectMessagesForRead({
      workspaceId: "w",
      messages: [
        {
          sourceId: "za:a:user:u:reply",
          text: "reply",
          contentAttributes: {
            zaloAccount: {
              quote: { providerMessageId: "p", text: "quoted-secret" },
            },
          },
        },
      ],
    })
    expect(projected?.text).toBe("reply")
    expect(JSON.stringify(projected)).not.toContain("quoted-secret")
  })
  it("does not acknowledge publication when Redis rejects after shard application", async () => {
    m.find.mockResolvedValue(row)
    m.publish.mockRejectedValue(new Error("redis down"))
    await expect(service.repair(row as never)).rejects.toThrow("redis down")
    expect(m.applied).toHaveBeenCalled()
    expect(m.published).not.toHaveBeenCalled()
  })
})
it("denies stale ordinary attachment tokens for a pending Zalo recall", async () => {
  m.find.mockResolvedValue(row)
  expect(
    await service.isOrdinaryAttachmentVisible({
      workspaceId: "w",
      messageId: "m",
      messageCreatedAt: input.messageCreatedAt,
      providerMessageIds: ["p"],
    }),
  ).toBe(false)
  expect(m.head).not.toHaveBeenCalled()
  expect(m.sign).not.toHaveBeenCalled()
})
it("keeps ordinary media on another channel unchanged", async () => {
  m.message.mockResolvedValue({
    sourceId: "messenger-source",
    deletedAt: null,
    text: "visible",
  })
  expect(
    await service.isOrdinaryAttachmentVisible({
      workspaceId: "w",
      messageId: "m",
      messageCreatedAt: input.messageCreatedAt,
    }),
  ).toBe(true)
  expect(m.find).not.toHaveBeenCalled()
})

it("a workspace purge winning the child-write guard prevents shard repair writes", async () => {
  m.lock.mockRejectedValue(new Error("Workspace is being purged"))
  await expect(service.repair(row as never)).rejects.toThrow(
    "Workspace is being purged",
  )
  expect(m.exact).not.toHaveBeenCalled()
  expect(m.publish).not.toHaveBeenCalled()
})

it("a historical placeholder retry reuses the existing row and stays not captured", async () => {
  const pending = { ...row, originalObservedAt: null }
  m.find.mockResolvedValue(pending)
  m.message.mockResolvedValue({
    id: "m",
    createdAt: input.messageCreatedAt,
    contentAttributes: { zaloAccount: { lifecycle: { placeholder: true } } },
  })
  await service.repair(pending as never)
  expect(m.createStable).not.toHaveBeenCalled()
  expect(m.observed).not.toHaveBeenCalled()
  expect(m.exact).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "m",
      createdAt: input.messageCreatedAt,
      lifecycle: expect.objectContaining({
        placeholder: true,
        originalObserved: false,
      }),
    }),
  )
})

it("redacts legacy outgoing quote snapshots stored outside zaloAccount.group", async () => {
  m.batch.mockResolvedValue([row])
  const result = await service.projectMessagesForRead({
    workspaceId: "w",
    messages: [
      {
        sourceId: "za:a:user:u:reply",
        text: "reply body",
        contentAttributes: {
          zaloAccountQuote: {
            providerMessageId: "p",
            text: "legacy-quoted-original-secret",
            url: "https://provider/legacy-secret",
          },
        },
      },
    ],
  })
  expect(result[0]?.text).toBe("reply body")
  expect(JSON.stringify(result)).not.toContain("original-secret")
  expect(JSON.stringify(result)).not.toContain("https://provider")
  expect(result[0]?.contentAttributes).toMatchObject({
    zaloAccount: {
      retainedQuote: {
        sourceId: "za:a:user:u:p",
        lifecycle: { recalled: true },
      },
    },
  })
})

describe("retained private media ledger", () => {
  const media = (overrides = {}) => ({
    reference: {
      id: "ref",
      workspaceId: "w",
      accountId: "a",
      ownerKind: "message",
      messageId: "m",
      messageCreatedAt: input.messageCreatedAt,
      conversationId: "c",
      attachmentId: "file",
      role: "original",
      slot: "0",
    },
    asset: {
      state: "stored",
      deletionPhase: "active",
      objectKey: "workspace/w/zalo-account/a/original",
      kind: "image",
      fileName: "original.jpg",
      mimeType: "image/jpeg",
      size: 123,
      ...overrides,
    },
  })
  beforeEach(async () => {
    m.message.mockResolvedValue({
      ...(await m.message()),
      deletedAt: new Date(),
    })
    m.media.mockResolvedValue([media()])
    m.head.mockResolvedValue({})
    m.sign.mockResolvedValue("https://private-signed")
  })
  it("reads an original stored after undo even while attachment projection remains a provider URL", async () => {
    expect(await service.getSavedContent(input)).toMatchObject({
      attachments: [{ id: "file", availability: "stored" }],
    })
    expect(
      await service.getSavedAttachment({ ...input, attachmentId: "file" }),
    ).toMatchObject({
      availability: "stored",
      url: "https://private-signed",
      size: 123,
    })
    expect(m.sign).toHaveBeenCalledWith(
      "workspace/w/zalo-account/a/original",
      60,
    )
  })
  it("resolves alias-rebound original by its bounded slot", async () => {
    const entry = media()
    entry.reference.attachmentId = null as never
    m.media.mockResolvedValue([entry])
    expect(
      await service.getSavedAttachment({ ...input, attachmentId: "file" }),
    ).toMatchObject({ availability: "stored" })
  })
  it("lists and signs descriptor-only resources by an opaque saved attachment id", async () => {
    m.message.mockResolvedValue({ ...(await m.message()), attachments: [] })
    const entry = media()
    entry.reference.attachmentId = null as never
    m.media.mockResolvedValue([entry])
    expect(await service.getSavedContent(input)).toMatchObject({
      attachments: [
        {
          id: "media:ref",
          referenceId: "ref",
          source: "media",
          availability: "stored",
        },
      ],
    })
    expect(
      await service.getSavedAttachment({ ...input, attachmentId: "media:ref" }),
    ).toMatchObject({ availability: "stored" })
  })
  it("does not sign a closing asset or fall back to a legacy copy", async () => {
    m.media.mockResolvedValue([media({ deletionPhase: "closing" })])
    expect(
      await service.getSavedAttachment({ ...input, attachmentId: "file" }),
    ).toMatchObject({ availability: "unavailable", url: null })
    expect(m.sign).not.toHaveBeenCalled()
  })
  it("rejects foreign references, wrong timestamp, and hard-purged parent", async () => {
    const entry = media()
    entry.reference.messageCreatedAt = new Date("2025-01-01")
    m.media.mockResolvedValue([entry])
    await expect(
      service.getSavedAttachment({ ...input, attachmentId: "media:ref" }),
    ).rejects.toThrow()
    m.message.mockResolvedValue(null)
    await expect(
      service.getSavedAttachment({ ...input, attachmentId: "media:ref" }),
    ).rejects.toThrow()
    expect(m.sign).not.toHaveBeenCalled()
  })
})

describe("retained echo media aliases", () => {
  const persist = vi.fn()
  const capture = () =>
    service.persistOriginal({
      inboxId: "in",
      message: {
        workspaceId: "w",
        conversationId: "c",
        contactInboxId: "ci",
        sourceId: "za:a:user:u:p",
        messageType: "outgoing",
        id: "echo",
        createdAt: input.messageCreatedAt,
      } as never,
      attachments: [],
      persist,
    })
  beforeEach(() => {
    process.env.ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED = "true"
    m.attempt.mockResolvedValue({
      messageId: "m",
      messageCreatedAt: input.messageCreatedAt,
      providerMessageIds: ["p"],
    })
    m.message.mockResolvedValue({
      id: "m",
      conversationId: "c",
      contactInboxId: "ci",
      createdAt: input.messageCreatedAt,
      attachments: [],
    })
    m.find.mockResolvedValue(null)
    m.bindMediaAliases.mockResolvedValue(1)
    persist.mockClear()
  })
  it("commits media alias rebinding before destructive shard echo reconciliation", async () => {
    await capture()
    expect(m.bindMediaAliases).toHaveBeenCalledWith({
      workspaceId: "w",
      accountId: "a",
      messageId: "m",
      conversationId: "c",
      messageCreatedAt: input.messageCreatedAt,
      aliases: ["p"],
      preserveAttachmentIds: true,
    })
    expect(m.bindMediaAliases.mock.invocationCallOrder[0]).toBeLessThan(
      m.reconcile.mock.invocationCallOrder[0] as number,
    )
    expect(persist).not.toHaveBeenCalled()
    delete process.env.ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED
  })
  it("does not delete an echo when durable alias registration fails", async () => {
    m.bindMediaAliases.mockRejectedValueOnce(new Error("ledger unavailable"))
    await expect(capture()).rejects.toThrow("ledger unavailable")
    expect(m.reconcile).not.toHaveBeenCalled()
    delete process.env.ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED
  })
})

describe("secondary outgoing aliases", () => {
  const persist = vi.fn()
  const ingest = () =>
    service.persistOriginal({
      inboxId: "in",
      message: {
        workspaceId: "w",
        conversationId: "c",
        contactInboxId: "ci",
        sourceId: "za:a:user:u:p",
        messageType: "outgoing",
        id: "echo",
        createdAt: input.messageCreatedAt,
      } as never,
      attachments: [],
      persist,
    })
  beforeEach(() => {
    m.attempt.mockResolvedValue({
      messageId: "m",
      messageCreatedAt: input.messageCreatedAt,
      providerMessageIds: ["primary", "p"],
    })
    m.message.mockResolvedValue({
      id: "m",
      createdAt: input.messageCreatedAt,
      conversationId: "c",
      contactInboxId: "ci",
      sourceId: "za:a:user:u:primary",
      messageType: "outgoing",
      attachments: [],
    })
    persist.mockReset()
  })
  it("keeps the primary source and uses the alias-aware reparenting path", async () => {
    expect(await ingest()).toMatchObject({ isNew: false, message: { id: "m" } })
    expect(m.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "za:a:user:u:primary",
        aliasSources: ["za:a:user:u:primary", "za:a:user:u:p"],
      }),
    )
    expect(persist).not.toHaveBeenCalled()
  })
  it("applies an undo received before the secondary echo to the canonical primary without resurrection", async () => {
    m.find.mockResolvedValue(row)
    m.pointer.mockResolvedValue(row)
    m.observed.mockResolvedValue(row)
    m.message.mockResolvedValue({
      ...(await m.message()),
      deletedAt: new Date(),
    })
    expect(await ingest()).toMatchObject({
      isNew: false,
      message: { id: "m", attachments: [] },
    })
    expect(m.reconcile).not.toHaveBeenCalled()
    expect(m.exact).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "za:a:user:u:primary", id: "m" }),
    )
    expect(m.createStable).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })
  it("refuses to recreate a hard-purged canonical message from its secondary echo", async () => {
    m.message.mockResolvedValue(null)
    await expect(ingest()).rejects.toThrow()
    expect(m.createStable).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })
  it("uses an exact canonical pointer to show secondary recall lifecycle in saved content", async () => {
    m.pointerRows.mockResolvedValue([row])
    expect(await service.getSavedContent(input)).toMatchObject({
      lifecycle: { recalled: true },
    })
  })
  it("repairs a secondary recall using the exact canonical primary source", async () => {
    m.find.mockResolvedValue(row)
    await service.repair(row as never)
    expect(m.exact).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "za:a:user:u:primary", id: "m" }),
    )
  })
})

it("keeps ambiguous provider slot-zero originals as distinct saved resources", async () => {
  const entry = (id: string, key: string) => ({
    reference: {
      id,
      workspaceId: "w",
      accountId: "a",
      ownerKind: "message",
      messageId: "m",
      messageCreatedAt: input.messageCreatedAt,
      conversationId: "c",
      attachmentId: null,
      role: "original",
      slot: "0",
    },
    asset: {
      state: "stored",
      deletionPhase: "active",
      objectKey: `workspace/w/zalo-account/a/${key}`,
      kind: "image",
      mimeType: "image/jpeg",
      size: 12,
    },
  })
  m.media.mockResolvedValue([entry("r1", "one"), entry("r2", "two")])
  const saved = await service.getSavedContent(input)
  expect(saved.attachments.map((a) => a.id)).toEqual([
    "file",
    "media:r1",
    "media:r2",
  ])
  expect(
    await service.getSavedAttachment({ ...input, attachmentId: "file" }),
  ).toMatchObject({ availability: "not_archived" })
  m.head.mockResolvedValue({})
  m.sign.mockResolvedValue("signed")
  await service.getSavedAttachment({ ...input, attachmentId: "media:r2" })
  expect(m.sign).toHaveBeenCalledWith("workspace/w/zalo-account/a/two", 60)
})
