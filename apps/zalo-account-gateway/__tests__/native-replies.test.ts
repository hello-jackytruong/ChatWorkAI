import { describe, expect, it, vi } from "vitest"
import { runProviderNativeReplies } from "../src/runtime/native-replies"

type Provider = Parameters<typeof runProviderNativeReplies>[0]
const ownUid = "900000000000000018"
const unrelatedUid = "900000000000000019"
const imageUrl =
  "https://photo.zdn.vn/photo-original.jpg?expires=123&signature=private"
const imageRevision =
  "02d20bbd7e394ad5999a4cebabac9619732c343a4cac99470c03e23ba2bdc2bc"
const futureStart = Date.UTC(2026, 10, 28, 11)
const futureEnd = Date.UTC(2026, 10, 29, 0, 30)
const download = vi.hoisted(() => vi.fn())
vi.mock("../src/runtime/outbound-attachment", () => ({
  downloadOutboundAttachment: download,
}))

function quick(
  id: number,
  keyword: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    keyword,
    type: 0,
    message: { title: `Reply ${id}`, params: "" },
    media: null,
    createdTime: futureStart,
    lastModified: futureStart,
    ...overrides,
  }
}

function auto(id: number, scope: number, uids: string[] | null = null) {
  return {
    id,
    scope,
    uids,
    enable: true,
    content: `Reply ${id}`,
    startTime: futureStart,
    endTime: futureEnd,
    recurrence: ["RRULE:FREQ=DAILY;"],
    ownerId: unrelatedUid,
    weight: 8,
    modifiedTime: futureStart,
    createdTime: futureStart,
  }
}

function provider() {
  const records = [
    quick(1, "hello"),
    quick(2, "image", {
      type: 1,
      media: { items: [{ photoId: 55, rawUrl: imageUrl }] },
    }),
    quick(3, "expired", {
      type: 1,
      media: {
        items: [{ photoId: 56, rawUrl: "https://evil.example/private.png" }],
      },
    }),
    quick(4, "unrecognized", {
      message: { title: "Visible content", params: "opaque-provider-format" },
    }),
  ]
  const getOwnId = vi.fn(() => ownUid)
  const getBizAccount = vi.fn(async () => ({ pkgId: 2 }))
  const getQuickMessageList = vi.fn(async () => ({
    items: records,
    version: 5,
    cursor: 0,
  }))
  const addQuickMessage = vi.fn(async () => ({
    item: quick(10, "new", { message: { title: "New content", params: "" } }),
    version: 6,
  }))
  const updateQuickMessage = vi.fn(async () => ({
    item: quick(2, "new", { message: { title: "New content", params: "" } }),
    version: 6,
  }))
  const removeQuickMessage = vi.fn(async () => ({ itemIds: [2], version: 6 }))
  const getAutoReplyList = vi.fn(async () => ({
    item: [
      auto(1, 0, [unrelatedUid]),
      auto(2, 1),
      auto(3, 2, [unrelatedUid]),
      auto(4, 3, [unrelatedUid]),
    ],
    version: 8,
  }))
  const createAutoReply = vi.fn(async () => ({ item: auto(9, 0), version: 9 }))
  const updateAutoReply = vi.fn(async () => ({ item: auto(2, 1), version: 9 }))
  const deleteAutoReply = vi.fn(async () => ({ item: 3, version: 9 }))
  const authorize = vi.fn(async () => undefined)
  const methods = {
    getOwnId,
    getBizAccount,
    getQuickMessageList,
    addQuickMessage,
    updateQuickMessage,
    removeQuickMessage,
    getAutoReplyList,
    createAutoReply,
    updateAutoReply,
    deleteAutoReply,
  }
  return { api: methods as unknown as Provider, ...methods, authorize }
}

describe("native Zalo quick messages and auto replies adapter", () => {
  it("reads quick templates from the single provider snapshot and preserves text even when a media source is missing", async () => {
    const mock = provider()
    const result = await runProviderNativeReplies(
      mock.api,
      { kind: "readQuickMessages" },
      mock.authorize,
    )
    expect(result).toMatchObject({
      kind: "readQuickMessages",
      outcome: "partial",
      quickMessages: {
        version: "5",
        providerCursor: 0,
        items: [
          { id: 1, keyword: "hello", title: "Reply 1", hasMedia: false },
          {
            id: 2,
            keyword: "image",
            title: "Reply 2",
            hasMedia: true,
            media: { photoId: "55", url: imageUrl },
          },
          { id: 3, keyword: "expired", title: "Reply 3", hasMedia: true },
          {
            id: 4,
            keyword: "unrecognized",
            title: "Visible content",
            hasMedia: false,
          },
        ],
      },
    })
    expect(result.quickMessages?.items[2]).not.toHaveProperty("media")
    expect(JSON.stringify(result)).not.toContain("evil.example")
    expect(JSON.stringify(result)).not.toContain("opaque-provider-format")
    expect(mock.getQuickMessageList).toHaveBeenCalledExactlyOnceWith()
    expect(mock.getAutoReplyList).not.toHaveBeenCalled()
    expect(mock.authorize).not.toHaveBeenCalled()
  })

  it("pages known rows locally and rejects stale snapshot versions without using provider cursors as inputs", async () => {
    const mock = provider()
    mock.getQuickMessageList.mockResolvedValue({
      items: Array.from({ length: 35 }, (_, index) =>
        quick(index + 1, `k${index}`),
      ),
      cursor: 17,
      version: 5,
    })
    const first = await runProviderNativeReplies(
      mock.api,
      { kind: "readQuickMessages" },
      mock.authorize,
    )
    expect(first.quickMessages?.items).toHaveLength(30)
    expect(first.quickMessages?.nextOffset).toBe(30)
    const page = await runProviderNativeReplies(
      mock.api,
      { kind: "readQuickMessages", offset: 30, expectedVersion: "5" },
      mock.authorize,
    )
    expect(page.quickMessages?.items.map(({ id }) => id)).toEqual([
      31, 32, 33, 34, 35,
    ])
    await expect(
      runProviderNativeReplies(
        mock.api,
        { kind: "readQuickMessages", offset: 30, expectedVersion: "4" },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable" })
    expect(mock.getQuickMessageList.mock.calls).toEqual([[], [], []])
  })

  it("writes text against the current version once and confirms only a new exact provider result", async () => {
    const mock = provider()
    await expect(
      runProviderNativeReplies(
        mock.api,
        {
          kind: "addQuickMessage",
          expectedVersion: "5",
          keyword: "new",
          title: "New content",
        },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "confirmed", version: "6", itemId: 10 })
    expect(mock.addQuickMessage).toHaveBeenCalledExactlyOnceWith({
      keyword: "new",
      title: "New content",
    })
    expect(mock.authorize).toHaveBeenCalledBefore(mock.addQuickMessage)
    expect(mock.authorize).toHaveBeenCalledOnce()
  })

  it("does not strip existing quick-message media or opaque provider parameters on implicit text edits", async () => {
    const mock = provider()
    for (const id of [2, 4]) {
      await expect(
        runProviderNativeReplies(
          mock.api,
          {
            kind: "updateQuickMessage",
            expectedVersion: "5",
            id,
            keyword: "new",
            title: "New content",
          },
          mock.authorize,
        ),
      ).resolves.toMatchObject({ outcome: "unavailable" })
    }
    expect(mock.authorize).not.toHaveBeenCalled()
    expect(mock.updateQuickMessage).not.toHaveBeenCalled()
    await expect(
      runProviderNativeReplies(
        mock.api,
        {
          kind: "updateQuickMessage",
          expectedVersion: "5",
          id: 2,
          keyword: "new",
          title: "New content",
          mediaMode: "remove",
        },
        mock.authorize,
      ),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      version: "6",
      itemId: 2,
      removedMediaRevision: imageRevision,
    })
    expect(mock.updateQuickMessage).toHaveBeenCalledExactlyOnceWith(
      { keyword: "new", title: "New content" },
      2,
    )
  })

  it("passes approved image bytes only to the selected replacement and does not dispatch a failed download", async () => {
    const mock = provider()
    const media = {
      url: "https://media.example/new.png",
      mimeType: "image/png",
    }
    download.mockRejectedValueOnce(new Error("expired source"))
    const operation = {
      kind: "updateQuickMessage" as const,
      expectedVersion: "5",
      id: 2,
      keyword: "new",
      title: "New content",
      mediaMode: "replace" as const,
      media,
    }
    await expect(
      runProviderNativeReplies(mock.api, operation, mock.authorize),
    ).resolves.toMatchObject({ outcome: "unavailable" })
    expect(mock.authorize).not.toHaveBeenCalled()
    expect(mock.updateQuickMessage).not.toHaveBeenCalled()
    const attachment = {
      data: Buffer.from("fake-bytes"),
      filename: "new.png",
      metadata: { totalSize: 10 },
    }
    download.mockResolvedValueOnce(attachment)
    mock.updateQuickMessage.mockResolvedValueOnce({
      item: quick(2, "new", {
        message: { title: "New content", params: "" },
        type: 1,
        media: { items: [{ photoId: 89, rawUrl: imageUrl }] },
      }),
      version: 6,
    })
    await expect(
      runProviderNativeReplies(mock.api, operation, mock.authorize),
    ).resolves.toMatchObject({ outcome: "confirmed", itemId: 2 })
    expect(mock.updateQuickMessage).toHaveBeenCalledExactlyOnceWith(
      { keyword: "new", title: "New content", media: attachment },
      2,
    )
  })

  it("uses exact account state and provider acknowledgment for deletes and never repeats an ambiguous write", async () => {
    const mock = provider()
    await expect(
      runProviderNativeReplies(
        mock.api,
        { kind: "deleteQuickMessage", expectedVersion: "4", id: 2 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable" })
    await expect(
      runProviderNativeReplies(
        mock.api,
        { kind: "deleteQuickMessage", expectedVersion: "5", id: 9 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable" })
    expect(mock.removeQuickMessage).not.toHaveBeenCalled()
    mock.removeQuickMessage.mockResolvedValueOnce({ itemIds: [99], version: 6 })
    await expect(
      runProviderNativeReplies(
        mock.api,
        { kind: "deleteQuickMessage", expectedVersion: "5", id: 2 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unknown" })
    expect(mock.removeQuickMessage).toHaveBeenCalledExactlyOnceWith(2)
    expect(mock.authorize).toHaveBeenCalledOnce()
  })

  it("identifies the previous image revision only for a confirmed quick message deletion", async () => {
    const mock = provider()
    await expect(
      runProviderNativeReplies(
        mock.api,
        { kind: "deleteQuickMessage", expectedVersion: "5", id: 2 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      itemId: 2,
      removedMediaRevision: imageRevision,
    })
  })

  it("derives the exact image revision from the CDN path when the provider gives no photo ID", async () => {
    const mock = provider()
    mock.getQuickMessageList.mockResolvedValueOnce({
      items: [
        quick(2, "image", {
          type: 1,
          media: { items: [{ rawUrl: imageUrl }] },
        }),
      ],
      version: 5,
      cursor: 0,
    })
    await expect(
      runProviderNativeReplies(
        mock.api,
        { kind: "deleteQuickMessage", expectedVersion: "5", id: 2 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      removedMediaRevision:
        "784dec0ec0a8a52447fe4332364ce6299c0efddcd9505a6280456f7903c5cf15",
    })
  })

  it("keeps scoped enablement, recipient IDs and millisecond times from the verified business account", async () => {
    const mock = provider()
    const result = await runProviderNativeReplies(
      mock.api,
      { kind: "readAutoReplies" },
      mock.authorize,
    )
    expect(result).toMatchObject({
      outcome: "confirmed",
      autoReplies: {
        version: "8",
        items: [
          {
            id: 1,
            scope: 0,
            enabled: true,
            uids: [],
            startTime: futureStart,
            endTime: futureEnd,
          },
          { id: 2, scope: 1, enabled: true, uids: [] },
          { id: 3, scope: 2, enabled: true, uids: [unrelatedUid] },
          {
            id: 4,
            scope: 3,
            enabled: true,
            uids: [unrelatedUid],
            recurrence: ["RRULE:FREQ=DAILY;"],
          },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain("ownerId")
    expect(mock.getBizAccount).toHaveBeenCalledExactlyOnceWith(ownUid)
    expect(mock.getAutoReplyList).toHaveBeenCalledExactlyOnceWith()
    expect(mock.getQuickMessageList).not.toHaveBeenCalled()
  })

  it("does not call auto replies for a personal package and requires exact rule evidence to delete", async () => {
    const mock = provider()
    mock.getBizAccount.mockResolvedValueOnce({ pkgId: 0 })
    await expect(
      runProviderNativeReplies(
        mock.api,
        { kind: "readAutoReplies" },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable" })
    expect(mock.getAutoReplyList).not.toHaveBeenCalled()
    await expect(
      runProviderNativeReplies(
        mock.api,
        { kind: "deleteAutoReply", expectedVersion: "8", id: 3 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "confirmed", itemId: 3, version: "9" })
    expect(mock.deleteAutoReply).toHaveBeenCalledExactlyOnceWith(3)
    expect(mock.authorize).toHaveBeenCalledBefore(mock.deleteAutoReply)
  })

  it("does not call a quick-message write if account dispatch authorization is withdrawn", async () => {
    const mock = provider()
    mock.authorize.mockRejectedValueOnce(new Error("scope changed"))
    await expect(
      runProviderNativeReplies(
        mock.api,
        {
          kind: "addQuickMessage",
          expectedVersion: "5",
          keyword: "new",
          title: "New content",
        },
        mock.authorize,
      ),
    ).rejects.toThrow("scope changed")
    expect(mock.addQuickMessage).not.toHaveBeenCalled()
  })
})
