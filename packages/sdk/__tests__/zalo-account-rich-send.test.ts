import { describe, expect, it } from "vitest"
import { zaloAccountOutboundMessageSchema } from "../src/lib/zalo-account"

const recipientId = "known-recipient"
const image = { kind: "image", url: "https://example.com/image.png" }
const file = { kind: "file", url: "https://example.com/document.pdf" }

describe("Zalo Account rich outbound contract", () => {
  it("preserves the legacy wire shape and its single-image caption rule", () => {
    const legacy = { recipientId, text: "Caption", attachments: [image] }
    expect(zaloAccountOutboundMessageSchema.parse(legacy)).toEqual(legacy)
    expect(
      zaloAccountOutboundMessageSchema.safeParse({
        ...legacy,
        attachments: [file],
      }).success,
    ).toBe(false)
  })

  it("keeps new mixed attachments in order with the explicit caption", () => {
    const content = {
      kind: "media",
      caption: "Hai tệp",
      attachments: [image, file],
    }
    expect(
      zaloAccountOutboundMessageSchema.parse({ recipientId, content }),
    ).toEqual({ recipientId, attachments: [], content })
    expect(
      zaloAccountOutboundMessageSchema.safeParse({
        recipientId,
        content,
        attachments: [image],
      }).success,
    ).toBe(false)
  })

  it("rejects an out-of-range style and unverified disappearing messages", () => {
    const content = {
      kind: "text",
      text: "A👩‍💻B",
      styles: [{ start: 1, len: 5, st: "b" }],
      urgency: 2,
    }
    expect(
      zaloAccountOutboundMessageSchema.safeParse({ recipientId, content })
        .success,
    ).toBe(true)
    expect(
      zaloAccountOutboundMessageSchema.safeParse({
        recipientId,
        content: { ...content, styles: [{ start: 1, len: 10, st: "b" }] },
      }).success,
    ).toBe(false)
    expect(
      zaloAccountOutboundMessageSchema.safeParse({
        recipientId,
        content: { ...content, ttl: 60_000 },
      }).success,
    ).toBe(false)
  })
})
