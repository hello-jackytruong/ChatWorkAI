// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const repo = {
    findById: vi.fn(),
    findTriggerMessage: vi.fn(),
    listByConversation: vi.fn(),
  }
  return {
    projectMedia: vi.fn().mockResolvedValue(new Map()),
    repo,
    createMessageRepository: vi.fn().mockResolvedValue(repo),
    getSafeSinceTime: vi.fn((value: Date | undefined) => value),
    resolveTenantSettings: vi
      .fn()
      .mockResolvedValue({ storageUrl: "https://storage.example.com" }),
    contactInboxService: {
      findByUncached: vi.fn().mockResolvedValue(null),
      findManyByIds: vi.fn().mockResolvedValue([]),
      findRecentByContactId: vi.fn().mockResolvedValue(null),
    },
    conversationService: {
      findBy: vi.fn().mockResolvedValue(undefined),
    },
    signMediaToken: vi.fn().mockResolvedValue("signed-media-token"),
    uploader: { getPresignedDownload: vi.fn() },
  }
})

vi.mock("../src/zalo-account-media/read-service", () => ({
  zaloAccountMediaReadService: { projectMessages: mocks.projectMedia },
}))

vi.mock("@chatbotx.io/encryption", () => ({
  signMediaToken: mocks.signMediaToken,
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  createMessageRepository: mocks.createMessageRepository,
  getSafeSinceTime: mocks.getSafeSinceTime,
}))

vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: mocks.uploader,
}))

vi.mock("../src/platform/settings", () => ({
  resolveTenantSettings: mocks.resolveTenantSettings,
  resolveWorkspaceAppUrl: vi.fn(async () => "https://app.example.com"),
}))

vi.mock("../src/contact-inbox/service", () => ({
  contactInboxService: mocks.contactInboxService,
}))

vi.mock("../src/conversation/service", () => ({
  conversationService: mocks.conversationService,
}))

vi.mock("../src/keys", () => ({
  keys: () => ({ NEXT_PUBLIC_BUILDER_URL: "https://app.example.com" }),
}))

const {
  findByIdWithUrls,
  findForContact,
  listForConversation,
  withResolvedAttachmentUrls,
} = await import("../src/message/list-for-conversation")

describe("message list-for-conversation", () => {
  test("redacts legacy raw send errors only on Zalo Account without extra lookups", async () => {
    const message = {
      id: "m",
      createdAt: new Date(),
      attachments: [],
      sendError: "SECRET https://private.invalid/token",
    }
    const zalo = await withResolvedAttachmentUrls(message as never, {
      channel: "zaloAccount",
      workspaceId: "w",
    })
    const other = await withResolvedAttachmentUrls(message as never, {
      channel: "messenger",
      workspaceId: "w",
    })
    expect(zalo.sendError).not.toContain("SECRET")
    expect(other.sendError).toBe(message.sendError)
    expect(mocks.createMessageRepository).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createMessageRepository.mockResolvedValue(mocks.repo)
    mocks.resolveTenantSettings.mockResolvedValue({
      storageUrl: "https://storage.example.com",
    })
    mocks.contactInboxService.findManyByIds.mockResolvedValue([])
    mocks.repo.listByConversation.mockResolvedValue({
      data: [],
      nextCursor: null,
    })
    mocks.repo.findById.mockResolvedValue({
      id: "msg-1",
      workspaceId: "ws-1",
      conversationId: "conv-1",
      attachments: [],
    })
    mocks.repo.findTriggerMessage.mockResolvedValue({
      id: "msg-1",
      workspaceId: "ws-1",
      conversationId: "conv-1",
      attachments: [],
    })
  })

  describe("findByIdWithUrls", () => {
    test("scopes repository lookup by workspaceId", async () => {
      const createdAt = new Date("2026-06-01T00:00:00Z")

      await findByIdWithUrls({ id: "msg-1", workspaceId: "ws-1", createdAt })

      expect(mocks.repo.findById).toHaveBeenCalledWith({
        id: "msg-1",
        createdAt,
        workspaceId: "ws-1",
      })
    })

    test("throws when no message is found", async () => {
      mocks.repo.findById.mockResolvedValue(null)

      await expect(
        findByIdWithUrls({
          id: "missing",
          workspaceId: "ws-1",
          createdAt: new Date(),
        }),
      ).rejects.toThrow()
    })
  })

  describe("findForContact", () => {
    test("uses conversation-scoped lookup without requiring createdAt from the caller", async () => {
      const conversationCreatedAt = new Date("2026-05-01T00:00:00Z")
      mocks.conversationService.findBy.mockResolvedValue({
        id: "conv-1",
        workspaceId: "ws-1",
        createdAt: conversationCreatedAt,
      })
      mocks.repo.findById.mockRejectedValue(new Error("unscoped lookup"))

      await findForContact({
        messageId: "msg-1",
        conversationId: "conv-1",
        workspaceId: "ws-1",
      })

      expect(mocks.conversationService.findBy).toHaveBeenCalledWith({
        where: { id: "conv-1", workspaceId: "ws-1" },
      })
      expect(mocks.repo.findTriggerMessage).toHaveBeenCalledWith({
        id: "msg-1",
        conversationId: "conv-1",
        workspaceId: "ws-1",
        sinceTime: conversationCreatedAt,
        requireCompleteResults: true,
      })
      expect(mocks.repo.findById).not.toHaveBeenCalled()
    })

    test("throws when the conversation does not exist", async () => {
      mocks.conversationService.findBy.mockResolvedValue(undefined)

      await expect(
        findForContact({
          messageId: "msg-1",
          conversationId: "missing-conv",
          workspaceId: "ws-1",
        }),
      ).rejects.toThrow()
    })
  })

  describe("listForConversation", () => {
    test("scopes conversation metadata lookup by workspaceId", async () => {
      await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      expect(mocks.conversationService.findBy).toHaveBeenCalledWith({
        where: { id: "conv-1", workspaceId: "ws-1" },
      })
    })

    test("seeds the cursor from the contact inbox's last message hour when none is given", async () => {
      const lastMessageAt = new Date("2026-06-10T15:42:00Z")
      mocks.conversationService.findBy.mockResolvedValue({
        id: "conv-1",
        workspaceId: "ws-1",
        contactId: "contact-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      mocks.contactInboxService.findRecentByContactId.mockResolvedValue({
        lastMessageAt,
      })

      await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      const call = mocks.repo.listByConversation.mock.calls[0]?.[0]
      expect(call.pagination.cursor.id).toBe("")
      // endOfHour: minutes/seconds pinned to the hour boundary (:59:59.999).
      expect(call.pagination.cursor.createdAt.getMinutes()).toBe(59)
    })

    test("a contactInboxId narrows the repository query and is looked up within the conversation's contact", async () => {
      mocks.conversationService.findBy.mockResolvedValue({
        id: "conv-1",
        workspaceId: "ws-1",
        contactId: "contact-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      mocks.contactInboxService.findByUncached.mockResolvedValue({
        lastMessageAt: new Date("2026-06-10T15:42:00Z"),
      })
      mocks.repo.listByConversation.mockResolvedValue({
        data: [],
        nextCursor: null,
      })

      await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        contactInboxId: "ci-2",
        limit: 20,
      })

      expect(mocks.contactInboxService.findByUncached).toHaveBeenCalledWith({
        where: { contactId: "contact-1", id: "ci-2" },
      })
      expect(mocks.repo.listByConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-1",
          conversationId: "conv-1",
          contactInboxId: "ci-2",
        }),
      )
    })

    test("a contactInboxId of another contact still filters the query (empty result)", async () => {
      mocks.conversationService.findBy.mockResolvedValue({
        id: "conv-1",
        workspaceId: "ws-1",
        contactId: "contact-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      mocks.contactInboxService.findByUncached.mockResolvedValue(null)
      mocks.repo.listByConversation.mockResolvedValue({
        data: [],
        nextCursor: null,
      })

      const result = await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        contactInboxId: "ci-foreign",
        limit: 20,
      })

      expect(mocks.repo.listByConversation).toHaveBeenCalledWith(
        expect.objectContaining({ contactInboxId: "ci-foreign" }),
      )
      expect(result).toEqual({ data: [], nextCursor: null })
    })

    test.each([
      "messenger",
      "instagram",
    ])("returns a signed proxy URL for a pending %s attachment", async (channel) => {
      mocks.contactInboxService.findManyByIds.mockResolvedValue([
        { id: "ci-1", channel },
      ])
      mocks.repo.listByConversation.mockResolvedValue({
        data: [
          {
            id: "msg-1",
            contactInboxId: "ci-1",
            attachments: [
              { id: "att-1", originPath: "https://graph.example/a.png" },
            ],
          },
        ],
        nextCursor: null,
      })

      const result = await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      expect(result.data[0].attachments[0].url).toBe(
        "https://app.example.com/media/attachment/signed-media-token",
      )
      expect(mocks.uploader.getPresignedDownload).not.toHaveBeenCalled()
    })

    test("resolves a freshly saved message's pending attachment to the proxy URL without any DB read", async () => {
      const message = {
        id: "msg-1",
        contactInboxId: "ci-1",
        createdAt: new Date("2026-10-14T01:00:00.000Z"),
        attachments: [
          { id: "att-1", originPath: "https://graph.example/a.png" },
          { id: "att-2", originPath: "workspace/messenger/ws-1/x/y.jpg" },
        ],
      }
      mocks.uploader.getPresignedDownload.mockResolvedValue(
        "https://signed.example/y.jpg",
      )

      const result = await withResolvedAttachmentUrls(message as never, {
        channel: "messenger",
        workspaceId: "ws-1",
      })

      expect(result.attachments.map((attachment) => attachment.url)).toEqual([
        "https://app.example.com/media/attachment/signed-media-token",
        "https://signed.example/y.jpg",
      ])
      expect(mocks.createMessageRepository).not.toHaveBeenCalled()
      expect(mocks.contactInboxService.findManyByIds).not.toHaveBeenCalled()
    })

    test("returns null for a permanently failed attachment", async () => {
      mocks.contactInboxService.findManyByIds.mockResolvedValue([
        { id: "ci-1", channel: "messenger" },
      ])
      mocks.repo.listByConversation.mockResolvedValue({
        data: [
          {
            id: "msg-1",
            contactInboxId: "ci-1",
            attachments: [{ id: "att-1", originPath: "failed:unresolvable" }],
          },
        ],
        nextCursor: null,
      })

      const result = await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      expect(result.data[0].attachments[0].url).toBeNull()
      expect(result.data[0].attachments[0].fallbackUrl).toBeNull()
      expect(mocks.uploader.getPresignedDownload).not.toHaveBeenCalled()
    })

    test("attaches a proxy fallback URL to a stored hydration-channel attachment", async () => {
      mocks.uploader.getPresignedDownload.mockResolvedValue(
        "https://signed.example.com/file",
      )
      mocks.contactInboxService.findManyByIds.mockResolvedValue([
        { id: "ci-1", channel: "messenger" },
      ])
      mocks.repo.listByConversation.mockResolvedValue({
        data: [
          {
            id: "msg-1",
            contactInboxId: "ci-1",
            attachments: [
              { id: "att-1", originPath: "workspace/ws-1/files/a.png" },
            ],
          },
        ],
        nextCursor: null,
      })

      const result = await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      expect(result.data[0].attachments[0].url).toBe(
        "https://signed.example.com/file",
      )
      expect(result.data[0].attachments[0].fallbackUrl).toBe(
        "https://app.example.com/media/attachment/signed-media-token",
      )
    })

    test("keeps the primary URL when signing the fallback URL fails", async () => {
      mocks.uploader.getPresignedDownload.mockResolvedValue(
        "https://signed.example.com/file",
      )
      mocks.signMediaToken.mockRejectedValueOnce(new Error("signer down"))
      mocks.contactInboxService.findManyByIds.mockResolvedValue([
        { id: "ci-1", channel: "messenger" },
      ])
      mocks.repo.listByConversation.mockResolvedValue({
        data: [
          {
            id: "msg-1",
            contactInboxId: "ci-1",
            attachments: [
              { id: "att-1", originPath: "workspace/ws-1/files/a.png" },
            ],
          },
        ],
        nextCursor: null,
      })

      const result = await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      expect(result.data[0].attachments[0].url).toBe(
        "https://signed.example.com/file",
      )
      expect(result.data[0].attachments[0].fallbackUrl).toBeNull()
    })

    test.each([
      "tiktok",
      "api",
    ])("keeps an absolute HTTP originPath unchanged for the %s channel", async (channel) => {
      const originPath = "http://media.example.com/external.png"
      mocks.contactInboxService.findManyByIds.mockResolvedValue([
        { id: "ci-1", channel },
      ])
      mocks.repo.listByConversation.mockResolvedValue({
        data: [
          {
            id: "msg-1",
            contactInboxId: "ci-1",
            attachments: [{ id: "att-1", originPath }],
          },
        ],
        nextCursor: null,
      })

      const result = await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      expect(result.data[0].attachments[0].url).toBe(originPath)
      expect(mocks.uploader.getPresignedDownload).not.toHaveBeenCalled()
    })

    test("presigns a stored attachment via the uploader", async () => {
      mocks.uploader.getPresignedDownload.mockResolvedValue(
        "https://signed.example.com/file",
      )
      mocks.repo.listByConversation.mockResolvedValue({
        data: [
          {
            id: "msg-1",
            contactInboxId: "ci-1",
            attachments: [{ id: "att-1", originPath: "ws-1/files/a.png" }],
          },
        ],
        nextCursor: null,
      })
      mocks.contactInboxService.findManyByIds.mockResolvedValue([
        { id: "ci-1", channel: "messenger" },
      ])

      const result = await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      expect(mocks.uploader.getPresignedDownload).toHaveBeenCalledWith(
        "ws-1/files/a.png",
      )
      expect(result.data[0].attachments[0].url).toBe(
        "https://signed.example.com/file",
      )
    })

    test("omits an attachment whose presigning fails instead of failing the page", async () => {
      mocks.uploader.getPresignedDownload.mockRejectedValue(
        new Error("signer down"),
      )
      mocks.repo.listByConversation.mockResolvedValue({
        data: [
          {
            id: "msg-1",
            contactInboxId: "ci-1",
            attachments: [{ id: "att-1", originPath: "ws-1/files/a.png" }],
          },
        ],
        nextCursor: null,
      })
      mocks.contactInboxService.findManyByIds.mockResolvedValue([
        { id: "ci-1", channel: "messenger" },
      ])

      const result = await listForConversation({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        limit: 20,
      })

      expect(result.data[0].attachments[0].url).toBeNull()
    })
  })
})

test("projects stored Zalo originals in one batch and never exposes source locators", async () => {
  const time = new Date("2026-11-23T00:00:00Z")
  const message = {
    id: "media-message",
    createdAt: time,
    contactInboxId: "ci-z",
    conversationId: "c",
    workspaceId: "ws-1",
    deletedAt: null,
    attachments: [
      {
        id: "att",
        originPath: "https://provider.test/a?token=secret",
        thumbnailPath: "https://provider.test/thumb?token=secret",
      },
    ],
  }
  mocks.repo.listByConversation.mockResolvedValue({
    data: [message],
    nextCursor: null,
  })
  mocks.contactInboxService.findManyByIds.mockResolvedValue([
    { id: "ci-z", channel: "zaloAccount", inboxId: "za-inbox" },
  ])
  mocks.projectMedia.mockResolvedValue(
    new Map([
      [
        message.id,
        [
          {
            referenceId: "ref",
            attachmentId: "att",
            role: "original",
            state: "stored",
            url: "https://signed.test/a",
          },
        ],
      ],
    ]),
  )
  const result = await listForConversation({ workspaceId: "ws-1", limit: 50 })
  expect(result.data[0]?.attachments[0]).toMatchObject({
    url: "https://signed.test/a",
    originPath: "",
    fallbackUrl: null,
  })
  expect(JSON.stringify(result)).not.toContain("token=secret")
  expect(mocks.projectMedia).toHaveBeenCalledTimes(1)
})

test("keeps authorized legacy Zalo storage reads when capture is disabled and there is no ledger", async () => {
  process.env.ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED = "false"
  mocks.projectMedia.mockResolvedValue(new Map())
  mocks.contactInboxService.findManyByIds.mockResolvedValue([
    { id: "ci-z", channel: "zaloAccount", inboxId: "i" },
  ])
  mocks.uploader.getPresignedDownload.mockResolvedValue(
    "https://signed.test/legacy",
  )
  const result = await withResolvedAttachmentUrls(
    {
      id: "m",
      createdAt: new Date(),
      contactInboxId: "ci-z",
      deletedAt: null,
      attachments: [
        { id: "legacy", originPath: "workspace/ws-1/uploads/a.png" },
      ],
    } as never,
    { channel: "zaloAccount", workspaceId: "ws-1" },
  )
  expect(result.attachments[0]?.url).toBe("https://signed.test/legacy")
})

test("projects only archived, standalone Zalo resource URLs and preserves card metadata", async () => {
  const richContent = {
    kind: "link",
    url: "https://original.example.test/article",
  }
  const result = await withResolvedAttachmentUrls(
    {
      id: "m",
      createdAt: new Date(),
      contactInboxId: "ci-z",
      contentAttributes: {
        zaloAccount: {
          richContent,
          group: {
            mentions: [],
            attachments: [
              { kind: "image", url: "https://provider.test/private-token" },
            ],
            mediaResources: [
              {
                kind: "image",
                role: "card_image",
                slot: "link_preview",
                url: "https://provider.test/private-token",
              },
            ],
          },
        },
      },
      attachments: [],
    } as never,
    {
      channel: "zaloAccount",
      workspaceId: "ws-1",
      retainedProjectionApplied: true,
      mediaProjection: new Map([
        [
          "m",
          [
            {
              referenceId: "preview",
              attachmentId: null,
              kind: "image",
              role: "card_image",
              slot: "link_preview",
              state: "stored",
              url: "https://signed.test/preview",
            },
            {
              referenceId: "legacy",
              attachmentId: "at",
              kind: "image",
              role: "original",
              state: "stored",
              url: "https://signed.test/attached",
            },
          ] as never,
        ],
      ]),
    },
  )
  expect(result.contentAttributes?.zaloAccount).toMatchObject({
    richContent,
    group: { mentions: [] },
    mediaResources: [
      {
        referenceId: "preview",
        url: "https://signed.test/preview",
        slot: "link_preview",
      },
      { referenceId: "legacy" },
    ],
  })
  expect(JSON.stringify(result)).not.toContain("private-token")
  expect(JSON.stringify(result)).not.toContain("signed.test/attached")
})
