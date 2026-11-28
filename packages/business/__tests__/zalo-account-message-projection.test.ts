import { describe, expect, it } from "vitest"
import { projectZaloAccountRetainedMessage } from "../src/zalo-account/message-projection"

describe("retained Zalo Account projection", () => {
  it("keeps only the validated album position for a locally hidden item", () => {
    const album = { layoutId: "album-2", index: 1, itemCount: 3 }
    const message = {
      sourceId: "za:a:group:g:p",
      text: "private caption",
      contentAttributes: {
        zaloAccount: { album, providerTtl: 60_000 },
      },
      attachments: [{ url: "https://private.test/a" }],
    }
    const recall = { id: "r1", lifecycleRevision: 1, localHiddenAt: new Date() }
    const projected = projectZaloAccountRetainedMessage(message, recall)
    expect(projected.contentAttributes.zaloAccount).toMatchObject({ album })
    expect(projected.contentAttributes.zaloAccount).not.toHaveProperty(
      "providerTtl",
    )
    expect(projected.attachments).toEqual([])
    expect(projected.text).toBeNull()
    expect(
      projectZaloAccountRetainedMessage(
        {
          ...message,
          contentAttributes: {
            zaloAccount: { album: { ...album, index: 99 } },
          },
        },
        recall,
      ).contentAttributes.zaloAccount,
    ).not.toHaveProperty("album")
  })

  it("shows rich content until the group message is hidden locally", () => {
    const richContent = {
      kind: "location",
      latitude: 10.78,
      longitude: 106.69,
    }
    const message = {
      sourceId: "za:a:group:g:p",
      text: "Location",
      attachments: [],
      contentAttributes: { zaloAccount: { richContent, providerTtl: 60 } },
    }
    expect(projectZaloAccountRetainedMessage(message)).toBe(message)

    const projected = projectZaloAccountRetainedMessage(message, {
      id: "r1",
      lifecycleRevision: 1,
      localHiddenAt: new Date(),
      originalObservedAt: new Date(),
    })
    expect(projected.text).toBeNull()
    expect(projected.contentAttributes.zaloAccount).not.toHaveProperty(
      "richContent",
    )
    expect(projected.contentAttributes.zaloAccount).not.toHaveProperty(
      "providerTtl",
    )
  })

  it("removes original fields and nested provider URLs while retaining safe state", () => {
    const message = {
      id: "m1",
      sourceId: "za:a:user:u:p",
      text: "original-secret",
      attachments: [
        { originPath: "private/key", url: "https://provider/secret" },
      ],
      contentAttributes: {
        quote: { text: "original-secret" },
        zaloAccount: {
          raw: "original-secret",
          lifecycle: {
            version: 1,
            lifecycleRevision: 2,
            recallId: "r1",
            recalled: true,
            originalObserved: true,
            placeholder: false,
          },
        },
      },
    }
    const projected = projectZaloAccountRetainedMessage(message)
    expect(projected.text).toBeNull()
    expect(projected.attachments).toEqual([])
    expect(JSON.stringify(projected)).not.toContain("original-secret")
    expect(JSON.stringify(projected)).not.toContain("https://provider")
    expect(message.text).toBe("original-secret")
  })
  it("fences a pending ledger before the shard marker is applied", () => {
    const message = {
      sourceId: "za:a:user:u:p",
      text: "secret",
      contentAttributes: null,
      attachments: [],
    }
    expect(
      projectZaloAccountRetainedMessage(message, {
        id: "r1",
        lifecycleRevision: 1,
        recallReceivedAt: new Date(),
        localHiddenAt: null,
        providerDeletedForMeAt: null,
        originalObservedAt: new Date(),
      }).text,
    ).toBeNull()
  })
  it("redacts legacy deleted Zalo content without claiming a provider recall", () => {
    const projected = projectZaloAccountRetainedMessage({
      sourceId: "za:a:user:u:p",
      deletedAt: new Date(),
      text: "legacy-secret",
      contentAttributes: null,
      attachments: [],
    })
    expect(projected.text).toBeNull()
    expect(JSON.stringify(projected)).toContain("legacyDeleted")
    expect(JSON.stringify(projected)).not.toContain('"recalled":true')
  })
  it("keeps another channel unchanged", () => {
    const message = {
      sourceId: "messenger-p",
      text: "hello",
      contentAttributes: { any: "value" },
    }
    expect(projectZaloAccountRetainedMessage(message)).toBe(message)
  })
})
