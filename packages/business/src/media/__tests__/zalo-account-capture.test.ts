import { describe, expect, it } from "vitest"
import {
  buildZaloMessageResources,
  redactZaloMediaLocators,
} from "../zalo-account-capture"

const context = {
  workspaceId: "1",
  accountId: "2",
  conversationId: "3",
  messageId: "4",
  messageCreatedAt: new Date("2026-11-23T00:00:00Z"),
  threadId: "peer",
  threadType: "user" as const,
  providerMessageId: "provider1",
}
describe("Zalo archival capture", () => {
  it("archives eligible media but skips stickers and GIFs with original URLs", () => {
    const resources = buildZaloMessageResources({
      ...context,
      descriptors: [
        {
          kind: "sticker",
          role: "original",
          slot: "static",
          url: "https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=892",
        },
        {
          kind: "gif",
          role: "original",
          slot: "animation",
          url: "https://photo.zdn.vn/a.gif",
        },
        {
          kind: "image",
          role: "original",
          slot: "photo",
          url: "https://photo.zdn.vn/a.jpg",
        },
      ],
    })
    expect(resources.map(({ kind }) => kind)).toEqual(["image"])
  })
  it("uses stable provider identity rather than a rotating URL token", () => {
    const first = buildZaloMessageResources({
      ...context,
      descriptors: [
        {
          kind: "image",
          role: "original",
          slot: "0",
          url: "https://a.zdn.vn/p?token=one",
        },
      ],
    })
    const next = buildZaloMessageResources({
      ...context,
      descriptors: [
        {
          kind: "image",
          role: "original",
          slot: "0",
          url: "https://a.zdn.vn/p?token=two",
        },
      ],
    })
    expect(first[0]?.ownerId).toBe(next[0]?.ownerId)
    expect(first[0]?.sourceRevision).toBe(next[0]?.sourceRevision)
    expect(first[0]?.source).toEqual({
      type: "provider_url",
      url: "https://a.zdn.vn/p?token=one",
    })
  })
  it("binds provider role slots to the existing original attachment", () => {
    const resources = buildZaloMessageResources({
      ...context,
      descriptors: [
        {
          kind: "image",
          role: "original",
          slot: "original",
          url: "https://a.zdn.vn/i",
        },
        {
          kind: "image",
          role: "thumbnail",
          slot: "thumbnail",
          url: "https://a.zdn.vn/t",
        },
      ],
      attachments: [
        { id: "5", fileType: "image", originPath: "https://a.zdn.vn/i" },
      ],
    })
    expect(resources.map((resource) => resource.attachmentId)).toEqual([
      "5",
      "5",
    ])
  })

  it("archives the uploaded object for outgoing sends rather than fetching the caller URL again", () => {
    const resources = buildZaloMessageResources({
      ...context,
      outgoing: true,
      attachments: [
        {
          id: "5",
          fileType: "file",
          originPath: "public/space/1/conversations/3/doc",
          name: "bill.pdf",
        },
      ],
    })
    expect(resources[0]?.source).toEqual({
      type: "storage_key",
      key: "public/space/1/conversations/3/doc",
    })
    expect(resources[0]?.attachmentId).toBe("5")
  })
  it("keeps originals and preview roles distinct and records supplied duration", () => {
    const resources = buildZaloMessageResources({
      ...context,
      descriptors: [
        {
          kind: "video",
          role: "original",
          slot: "0",
          url: "https://a.zdn.vn/v",
          durationMs: 1200,
        },
        {
          kind: "image",
          role: "poster",
          slot: "0",
          url: "https://a.zdn.vn/poster",
        },
      ],
    })
    expect(resources).toHaveLength(2)
    expect(resources.map((resource) => resource.role)).toEqual([
      "original",
      "poster",
    ])
    expect(resources[0]?.durationMs).toBe(1200)
  })
  it("bounds per-message registration and strips source URLs without mutating input", () => {
    const descriptors = Array.from({ length: 30 }, (_, n) => ({
      kind: "image",
      role: "original",
      slot: String(n),
      url: `https://a.zdn.vn/${n}`,
    }))
    expect(buildZaloMessageResources({ ...context, descriptors })).toHaveLength(
      12,
    )
    const attributes = {
      zaloAccount: { providerMessageId: "1", mediaResources: descriptors },
      other: "kept",
    }
    const safe = redactZaloMediaLocators(attributes)
    expect(JSON.stringify(safe)).not.toContain("https://")
    expect(attributes.zaloAccount.mediaResources[0]?.url).toBeDefined()
    expect(safe.other).toBe("kept")
  })
})
