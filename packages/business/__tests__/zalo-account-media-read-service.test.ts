import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  pointerRows: vi.fn(),
  recalls: vi.fn(),
  list: vi.fn(),
  parents: vi.fn(),
  inboxes: vi.fn(),
  account: vi.fn(),
  sign: vi.fn(),
  temporaryPreview: vi.fn(),
  source: vi.fn(),
  retry: vi.fn(),
  page: vi.fn(),
  register: vi.fn(),
  head: vi.fn(),
  objects: vi.fn(),
  known: vi.fn(),
  group: vi.fn(),
  contactOwner: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountMessageRecallRepository: {
    findTargets: mocks.recalls,
    findForMessages: mocks.pointerRows,
  },
  integrationZaloAccountGroupRepository: { findByProviderId: mocks.group },
  zaloAccountMediaRepository: {
    list: mocks.list,
    listForMessages: mocks.list,
    listForProfiles: mocks.list,
    findKnownObjectKeys: mocks.known,
  },
  createMessageRepository: async () => ({
    findManyForTranslation: mocks.parents,
    listByConversation: mocks.page,
  }),
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: {
    getPresignedDownload: mocks.sign,
    headObject: mocks.head,
    listObjects: mocks.objects,
  },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/contact-inbox/service", () => ({
  contactInboxService: {
    findManyByIds: mocks.inboxes,
    findByUncached: mocks.contactOwner,
  },
}))
vi.mock("../src/zalo-account-media/service", () => ({
  zaloAccountMediaService: {
    retry: mocks.retry,
    registerResources: mocks.register,
    readAssetSource: mocks.source,
  },
}))
vi.mock("../src/media/resolve-media-url", () => ({
  resolveZaloImagePreviewUrl: mocks.temporaryPreview,
}))
const secretsPattern = /objectKey|encryptedSource|workspace\/w/
const input = {
  workspaceId: "w",
  accountId: "a",
  conversationId: "c",
  referenceId: "r",
}
const time = new Date("2026-11-23T00:00:00Z")
const row = {
  reference: {
    id: "r",
    workspaceId: "w",
    accountId: "a",
    ownerKind: "message",
    ownerId: "m",
    messageId: "m",
    messageCreatedAt: time,
    conversationId: "c",
    sourceRevision: "v1",
    role: "original",
    projectionState: "pending",
  },
  asset: {
    id: "asset",
    state: "stored",
    deletionPhase: "active",
    objectKey: "workspace/w/zalo-account/a/original",
    encryptedSource: { secret: "secret" },
    mimeType: "image/png",
    fileName: "a.png",
    sourceRevision: "v1",
    kind: "image",
    errorCode: null,
  },
}
const { zaloAccountMediaReadService: service } = await import(
  "../src/zalo-account-media/read-service"
)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.recalls.mockResolvedValue([])
  mocks.pointerRows.mockResolvedValue([])
  mocks.account.mockResolvedValue({ id: "a", inboxId: "i" })
  mocks.list.mockResolvedValue([row])
  mocks.parents.mockResolvedValue([
    {
      id: "m",
      createdAt: time,
      conversationId: "c",
      contactInboxId: "ci",
      deletedAt: null,
    },
  ])
  mocks.inboxes.mockResolvedValue([
    { id: "ci", channel: "zaloAccount", inboxId: "i" },
  ])
  mocks.sign.mockResolvedValue("https://signed.example.test/a")
  mocks.temporaryPreview.mockResolvedValue(
    "https://app.example.test/media/attachment/signed-preview",
  )
  mocks.source.mockResolvedValue({
    type: "provider_url",
    url: "https://photo.zdn.vn/photo.jpeg?provider-token=short-lived",
  })
})
it("returns safe status and signs only after proving current message/account binding even flagoff", async () => {
  process.env.ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED = "false"
  const status = await service.get(input)
  expect(JSON.stringify(status)).not.toMatch(secretsPattern)
  expect(await service.download(input)).toMatchObject({
    url: "https://signed.example.test/a",
    expiresIn: 300,
  })
  expect(mocks.sign).toHaveBeenCalledWith(row.asset.objectKey, 300)
})
it("denies deleted/missing parent and account/inbox mismatch before signing", async () => {
  for (const parents of [
    [],
    [
      {
        id: "m",
        createdAt: time,
        conversationId: "c",
        contactInboxId: "ci",
        deletedAt: time,
      },
    ],
    [
      {
        id: "m",
        createdAt: time,
        conversationId: "other",
        contactInboxId: "ci",
        deletedAt: null,
      },
    ],
  ]) {
    mocks.parents.mockResolvedValue(parents)
    await expect(service.download(input)).rejects.toThrow()
    expect(mocks.sign).not.toHaveBeenCalled()
  }
  mocks.parents.mockResolvedValue([
    {
      id: "m",
      createdAt: time,
      conversationId: "c",
      contactInboxId: "ci",
      deletedAt: null,
    },
  ])
  mocks.inboxes.mockResolvedValue([
    { id: "ci", channel: "zaloAccount", inboxId: "other" },
  ])
  await expect(service.download(input)).rejects.toThrow()
  expect(mocks.sign).not.toHaveBeenCalled()
})
it("batches parent checks and filters inaccessible/deleted references without exposing source", async () => {
  mocks.list.mockResolvedValue([
    row,
    { ...row, reference: { ...row.reference, id: "r2", messageId: "missing" } },
  ])
  const result = await service.list({ ...input, limit: 50 })
  expect(result.data).toHaveLength(1)
  expect(mocks.parents).toHaveBeenCalledTimes(1)
  expect(mocks.inboxes).toHaveBeenCalledTimes(1)
})
it("requires exact requested reference and refuses signing an unfinished asset", async () => {
  mocks.list.mockResolvedValue([
    { ...row, reference: { ...row.reference, id: "other" } },
  ])
  await expect(service.get(input)).rejects.toThrow()
  mocks.list.mockResolvedValue([
    { ...row, asset: { ...row.asset, state: "pending" } },
  ])
  await expect(service.download(input)).rejects.toThrow()
  expect(mocks.sign).not.toHaveBeenCalled()
})

it("uses a short-lived preview while an image archives, then prefers R2 and keeps the source", async () => {
  const pending = {
    ...row,
    accountInboxId: "i",
    reference: { ...row.reference, attachmentId: "attachment" },
    asset: { ...row.asset, state: "downloading", objectKey: null },
  }
  mocks.list.mockResolvedValue([pending])
  const project = () =>
    service.projectMessages({
      workspaceId: input.workspaceId,
      messages: [
        {
          id: "m",
          createdAt: time,
          conversationId: "c",
          contactInboxId: "ci",
        } as never,
      ],
      inboxByContactInboxId: new Map([
        ["ci", { channel: "zaloAccount", inboxId: "i" }],
      ]),
    })
  expect((await project()).get("m")?.[0]?.url).toContain("/media/attachment/")
  expect(mocks.source).not.toHaveBeenCalled()
  expect(await service.previewImage(input)).toBe(
    "https://photo.zdn.vn/photo.jpeg?provider-token=short-lived",
  )
  mocks.source.mockClear()
  mocks.list.mockResolvedValue([{ ...pending, asset: row.asset }])
  expect((await project()).get("m")?.[0]?.url).toBe(
    "https://signed.example.test/a",
  )
  expect(await service.previewImage(input)).toBe(
    "https://signed.example.test/a",
  )
  expect(mocks.source).not.toHaveBeenCalled()
  expect(row.asset.encryptedSource).toEqual({ secret: "secret" })
})

it("refuses a non-Zalo redirect and never decrypts a hidden image", async () => {
  mocks.list.mockResolvedValue([
    { ...row, asset: { ...row.asset, state: "pending", objectKey: null } },
  ])
  mocks.source.mockResolvedValue({
    type: "provider_url",
    url: "https://photo.zadn.vn.example.test/a.png",
  })
  expect(await service.previewImage(input)).toBeNull()
  mocks.source.mockClear()
  mocks.parents.mockResolvedValue([])
  expect(await service.previewImage(input)).toBeNull()
  expect(mocks.source).not.toHaveBeenCalled()
})

it("lets an authorized sticker use its provider artwork after an archive failure", async () => {
  mocks.list.mockResolvedValue([
    {
      ...row,
      asset: {
        ...row.asset,
        kind: "sticker",
        state: "failed",
        objectKey: null,
      },
    },
  ])
  const url = "https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=892"
  mocks.source.mockResolvedValue({ type: "provider_url", url })
  expect(await service.previewImage(input)).toBe(url)
  mocks.source.mockResolvedValue({
    type: "provider_url",
    url: "https://zalo-api.zadn.vn/unknown?eid=892",
  })
  expect(await service.previewImage(input)).toBeNull()
})

it("bounds backfill to persisted rows and supports dry-run without registration", async () => {
  mocks.page.mockResolvedValue({ data: [], nextCursor: null })
  expect(
    await service.backfill({
      ...input,
      from: new Date(time.getTime() - 1000),
      to: time,
      dryRun: true,
      limit: 50,
    }),
  ).toMatchObject({ dryRun: true, registered: 0 })
  expect(mocks.register).not.toHaveBeenCalled()
})
it("reconciles dry-run with outage-as-unknown and never emits object keys", async () => {
  mocks.head.mockRejectedValue(new Error("storage outage"))
  mocks.objects.mockResolvedValue({ Contents: [] })
  mocks.known.mockResolvedValue([])
  const result = await service.reconcile({ ...input, dryRun: true, limit: 50 })
  expect(result.data[0]).toMatchObject({ referenceId: "r", status: "unknown" })
  expect(JSON.stringify(result)).not.toContain("workspace/w")
})

it("normal message projection refuses deleted parents and wrong account inbox bindings", async () => {
  const message = {
    id: "m",
    createdAt: time,
    conversationId: "c",
    contactInboxId: "ci",
    deletedAt: null,
  }
  mocks.list.mockResolvedValue([{ ...row, accountInboxId: "i" }])
  const binding = new Map([
    ["ci", { channel: "zaloAccount", inboxId: "wrong" }],
  ])
  expect(
    (
      await service.projectMessages({
        workspaceId: "w",
        messages: [message as never],
        inboxByContactInboxId: binding,
      })
    ).size,
  ).toBe(0)
  binding.set("ci", { channel: "zaloAccount", inboxId: "i" })
  expect(
    (
      await service.projectMessages({
        workspaceId: "w",
        messages: [{ ...message, deletedAt: time } as never],
        inboxByContactInboxId: binding,
      })
    ).size,
  ).toBe(0)
  expect(mocks.sign).not.toHaveBeenCalled()
})

it("paginates safe status with current parent/account checks and rejects unknown accounts", async () => {
  expect(await service.list({ ...input, limit: 1 })).toMatchObject({
    nextCursor: "r",
    data: [{ referenceId: "r" }],
  })
  mocks.account.mockResolvedValue(null)
  await expect(service.get(input)).rejects.toThrow()
  await expect(
    service.backfill({ ...input, from: time, to: time, dryRun: true }),
  ).rejects.toThrow()
})
it("retries the exact visible revision through the shared write service", async () => {
  mocks.retry.mockResolvedValue({ accepted: true, state: "pending" })
  expect(
    await service.retry({ ...input, expectedSourceRevision: "v1" }),
  ).toEqual({ accepted: true, state: "pending" })
  expect(mocks.retry).toHaveBeenCalledWith(
    expect.objectContaining({
      conversationIds: ["c"],
      manageResources: false,
      expectedSourceRevision: "v1",
    }),
  )
})
it("backfills a bounded persisted page with stable capture identity and supports dry run", async () => {
  const message = {
    id: "m",
    createdAt: time,
    contactInboxId: "ci",
    conversationId: "c",
    deletedAt: null,
    messageType: "incoming",
    sourceId: "za:a:user:peer:provider",
    contentAttributes: {
      zaloAccount: { threadId: "peer", providerMessageId: "provider" },
    },
    attachments: [
      {
        id: "att",
        createdAt: time,
        fileType: "image",
        originPath: "https://cdn.test/a",
        name: "a.png",
      },
    ],
  }
  mocks.page.mockResolvedValue({
    data: [message],
    nextCursor: { createdAt: time, id: "m" },
  })
  mocks.register.mockResolvedValue([{ id: "ref" }])
  const request = {
    ...input,
    from: new Date(time.getTime() - 1000),
    to: time,
    dryRun: false,
    limit: 50,
  }
  expect(await service.backfill(request)).toMatchObject({
    registered: 1,
    eligible: 1,
    nextCursor: { id: "m" },
  })
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({
      resources: [
        expect.objectContaining({
          ownerId: "user:peer:provider",
          attachmentId: "att",
          source: { type: "provider_url", url: "https://cdn.test/a" },
        }),
      ],
    }),
  )
  expect(mocks.page).toHaveBeenCalledWith(
    expect.objectContaining({
      pagination: { limit: 4, cursor: { createdAt: time, id: "" } },
    }),
  )
  mocks.register.mockClear()
  expect(await service.backfill({ ...request, dryRun: true })).toMatchObject({
    registered: 0,
    eligible: 1,
  })
  expect(mocks.register).not.toHaveBeenCalled()
})
it("ignores deleted, wrong-owner and out-of-window history rows and rejects oversized windows", async () => {
  const base = {
    id: "m",
    createdAt: time,
    contactInboxId: "ci",
    conversationId: "c",
    deletedAt: null,
    attachments: [],
  }
  mocks.page.mockResolvedValue({
    data: [
      { ...base, deletedAt: time },
      { ...base, conversationId: "other" },
      { ...base, createdAt: new Date(0) },
      { ...base, contentAttributes: null, sourceId: null },
    ],
    nextCursor: null,
  })
  expect(
    await service.backfill({
      ...input,
      from: new Date(time.getTime() - 1000),
      to: time,
      dryRun: true,
    }),
  ).toMatchObject({ eligible: 0, registered: 0 })
  await expect(
    service.backfill({ ...input, from: new Date(0), to: time, dryRun: true }),
  ).rejects.toThrow()
})
it("backfills outgoing private originals and group metadata using timestamp cursors", async () => {
  mocks.page.mockResolvedValue({
    data: [
      {
        id: "m",
        createdAt: time,
        contactInboxId: "ci",
        conversationId: "c",
        deletedAt: null,
        messageType: "outgoing",
        sourceId: "za:a:group:g:p",
        contentAttributes: {
          zaloAccount: { group: { threadId: "g", providerMessageId: "p" } },
        },
        attachments: [
          {
            id: "att",
            fileType: "file",
            originPath: "workspace/w/uploads/a.pdf",
          },
        ],
      },
    ],
    nextCursor: null,
  })
  mocks.register.mockResolvedValue([{ id: "ref" }])
  await service.backfill({
    ...input,
    from: time,
    to: time,
    dryRun: false,
    cursor: { createdAt: time, id: "cursor" },
  })
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({
      resources: [
        expect.objectContaining({
          ownerId: "group:g:p",
          source: { type: "storage_key", key: "workspace/w/uploads/a.pdf" },
        }),
      ],
    }),
  )
})
it("reconciles present and proven-missing objects while treating other errors as unknown", async () => {
  mocks.objects.mockResolvedValue({
    Contents: [
      { Key: row.asset.objectKey },
      { Key: "workspace/w/zalo-account/a/unreferenced" },
      { Key: "other/account/key" },
    ],
    NextContinuationToken: "continue",
  })
  mocks.known.mockResolvedValue([
    { objectKey: row.asset.objectKey, candidateKey: null, candidateKeys: [] },
  ])
  for (const [head, status] of [
    [() => Promise.resolve({}), "present"],
    [() => Promise.reject({ name: "NotFound" }), "missing"],
    [() => Promise.reject({ name: "NoSuchKey" }), "missing"],
    [() => Promise.reject({ name: "Forbidden" }), "unknown"],
  ] as const) {
    mocks.head.mockImplementation(head)
    const result = await service.reconcile({
      ...input,
      dryRun: true,
      objectCursor: "previous",
    })
    expect(result).toMatchObject({
      data: [{ referenceId: "r", status }],
      objectScanStatus: "complete",
      unreferencedCandidates: 1,
      nextObjectCursor: "continue",
    })
  }
  expect(mocks.objects).toHaveBeenCalledWith(
    "workspace/w/zalo-account/a/",
    { MaxKeys: 100, ContinuationToken: "previous" },
    expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
  )
  mocks.list.mockResolvedValue([
    { ...row, asset: { ...row.asset, state: "pending" } },
  ])
  expect((await service.reconcile({ ...input, dryRun: true })).data).toEqual([])
})
it("profile projections preserve private account scope, role, and missing source status", async () => {
  const owners = [
    { accountId: "a", ownerKind: "account" as const, ownerId: "a" },
  ]
  const profile = {
    ...row,
    reference: {
      ...row.reference,
      ownerKind: "account",
      ownerId: "a",
      role: "avatar",
    },
  }
  mocks.list.mockResolvedValue([
    profile,
    { ...profile, reference: { ...profile.reference, role: "cover" } },
    { ...profile, asset: { ...profile.asset, state: "pending" } },
    { ...profile, asset: { ...profile.asset, objectKey: "workspace/other/a" } },
    { ...profile, reference: { ...profile.reference, ownerId: "unrelated" } },
  ])
  expect(await service.projectProfiles({ workspaceId: "w", owners })).toEqual(
    new Map([
      [
        JSON.stringify(["a", "account", "a"]),
        {
          avatarUrl: "https://signed.example.test/a",
          coverUrl: "https://signed.example.test/a",
        },
      ],
    ]),
  )
})
it("projects safe stored/pending message resources without provider or storage calls per row", async () => {
  const message = {
    id: "m",
    createdAt: time,
    conversationId: "c",
    contactInboxId: "ci",
    deletedAt: null,
  }
  mocks.list.mockResolvedValue([
    { ...row, accountInboxId: "i" },
    {
      ...row,
      reference: { ...row.reference, id: "r2" },
      asset: { ...row.asset, state: "failed", errorCode: "raw private error" },
      accountInboxId: "i",
    },
  ])
  const result = await service.projectMessages({
    workspaceId: "w",
    messages: [message as never],
    inboxByContactInboxId: new Map([
      ["ci", { channel: "zaloAccount", inboxId: "i" }],
    ]),
  })
  expect(result.get("m")).toMatchObject([
    { url: "https://signed.example.test/a" },
    { url: null, errorCode: "transfer_failed" },
  ])
  expect(mocks.list).toHaveBeenCalledTimes(1)
  expect(mocks.sign).toHaveBeenCalledTimes(1)
})

it("labels provider hints and detected metadata truthfully", async () => {
  for (const [asset, expected] of [
    [
      {
        ...row.asset,
        width: null,
        height: null,
        duration: null,
        providerMetadata: { width: 200, height: 100, durationMs: 3000 },
      },
      {
        width: 200,
        height: 100,
        durationMs: 3000,
        dimensionsSource: "provider",
        durationSource: "provider",
      },
    ],
    [
      { ...row.asset, width: 400, height: 200, duration: 5000 },
      {
        dimensionsSource: "detected",
        durationSource: "detected",
        durationMs: 5000,
      },
    ],
  ] as const) {
    mocks.list.mockResolvedValue([{ ...row, asset }])
    expect(await service.get(input)).toMatchObject(expected)
  }
})

it("management reads require a current account/group/contact parent and preserve exact owner scope", async () => {
  for (const ownerKind of ["account", "group", "contact", "sticker"] as const) {
    const ownerId = ownerKind === "account" ? "a" : "provider"
    mocks.group.mockResolvedValue({ id: "group" })
    mocks.contactOwner.mockResolvedValue({ id: "ci" })
    mocks.list.mockResolvedValue([
      {
        ...row,
        reference: {
          ...row.reference,
          ownerKind,
          ownerId,
          conversationId: null,
          role: "avatar",
        },
      },
    ])
    expect(
      await service.download({
        workspaceId: "w",
        accountId: "a",
        ownerKind,
        ownerId,
        referenceId: "r",
      }),
    ).toMatchObject({ url: "https://signed.example.test/a" })
  }
  mocks.sign.mockClear()
  mocks.group.mockResolvedValue(null)
  mocks.contactOwner.mockResolvedValue(null)
  for (const ownerKind of ["account", "group", "contact"] as const) {
    await expect(
      service.get({
        workspaceId: "w",
        accountId: "a",
        ownerKind,
        ownerId: "missing",
        referenceId: "r",
      }),
    ).rejects.toThrow()
  }
  expect(mocks.sign).not.toHaveBeenCalled()
})

it("returns retry timestamps and verified checksum for media tracking", async () => {
  const lastAttemptAt = new Date("2026-11-23T00:00:00Z")
  const nextAttemptAt = new Date("2026-11-23T00:00:30Z")
  mocks.list.mockResolvedValue([
    {
      ...row,
      asset: {
        ...row.asset,
        lastAttemptAt,
        nextAttemptAt,
        checksum: "a".repeat(64),
        providerResourceId: "provider-file",
      },
    },
  ])
  expect(await service.get(input)).toMatchObject({
    lastAttemptAt,
    nextAttemptAt,
    checksum: "a".repeat(64),
    providerResourceId: "provider-file",
  })
})

it.each([
  "recallReceivedAt",
  "localHiddenAt",
])("denies normal media signing while %s has not projected to deletedAt", async (field) => {
  const parent = {
    ...(await mocks.parents())[0],
    sourceId: "za:a:user:u:p",
    deletedAt: null,
  }
  mocks.parents.mockResolvedValue([parent])
  mocks.recalls.mockResolvedValue([
    {
      accountId: "a",
      threadType: "user",
      threadId: "u",
      providerMessageId: "p",
      [field]: new Date(),
    },
  ])
  await expect(service.download(input)).rejects.toThrow()
  expect(mocks.sign).not.toHaveBeenCalled()
  expect(
    await service.projectMessages({
      workspaceId: "w",
      messages: [{ ...parent, attachments: [] }] as never,
      inboxByContactInboxId: new Map([
        ["ci", { channel: "zaloAccount", inboxId: "i" }],
      ]),
    }),
  ).toEqual(new Map())
})

it("keeps normal archive access after provider-only deletion", async () => {
  mocks.parents.mockResolvedValue([
    {
      ...(await mocks.parents())[0],
      sourceId: "za:a:user:u:p",
      deletedAt: null,
    },
  ])
  mocks.recalls.mockResolvedValue([
    {
      accountId: "a",
      threadType: "user",
      threadId: "u",
      providerMessageId: "p",
      providerDeletedForMeAt: new Date(),
    },
  ])
  expect(await service.download(input)).toMatchObject({
    url: "https://signed.example.test/a",
  })
})

it("denies a secondary recall bound to the exact canonical pointer", async () => {
  const parent = {
    ...(await mocks.parents())[0],
    sourceId: "za:a:user:u:primary",
    deletedAt: null,
  }
  mocks.parents.mockResolvedValue([parent])
  mocks.pointerRows.mockResolvedValue([
    {
      accountId: "a",
      messageId: "m",
      messageCreatedAt: time,
      conversationId: "c",
      recallReceivedAt: new Date(),
    },
  ])
  await expect(service.download(input)).rejects.toThrow()
  expect(mocks.sign).not.toHaveBeenCalled()
})
