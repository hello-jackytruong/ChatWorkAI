// @vitest-environment node

import { describe, expect, test } from "vitest"
import {
  createMessageRequest,
  createMessageWithRoutingBypassRequest,
} from "@/features/messages/schema/mutation"

const composerRequest = createMessageWithRoutingBypassRequest
const envelope = { inboxId: "11", clientId: "12" }

describe("Zalo Account composer send request", () => {
  test("keeps the ordered album and the caption with the existing reply pointer", () => {
    const request = {
      ...envelope,
      zaloAccountUpload: {
        type: "media",
        caption: "Three attachments",
        mediaFileIds: ["99", "55", "77"],
      },
      replyToMessageId: "321",
      replyToMessageCreatedAt: new Date("2026-01-01T00:00:00Z"),
    }
    expect(composerRequest.parse(request)).toEqual(request)
  })

  test("rejects unsafe or mixed rich content instead of silently sending plain text", () => {
    expect(
      composerRequest.safeParse({
        ...envelope,
        text: "Do not send on its own",
        zaloAccountContent: { kind: "link", url: "javascript:alert(1)" },
      }).success,
    ).toBe(false)
    expect(
      composerRequest.safeParse({
        ...envelope,
        zaloAccountContent: { kind: "link", url: "https://example.com/" },
        zaloAccountUpload: { type: "media", mediaFileIds: ["51"] },
      }).success,
    ).toBe(false)
  })

  test("requires a poster for video and rejects an oversized device file", () => {
    const video = { type: "video", mediaFileId: "23" }
    expect(
      composerRequest.safeParse({ ...envelope, zaloAccountUpload: video })
        .success,
    ).toBe(false)
    expect(
      composerRequest.safeParse({
        ...envelope,
        zaloAccountUpload: { ...video, posterMediaFileId: "24" },
      }).success,
    ).toBe(true)

    const oversized = new File([new Uint8Array(5_000_001)], "voice.m4a")
    expect(
      composerRequest.safeParse({
        ...envelope,
        zaloAccountUpload: { type: "voice", file: oversized },
      }).success,
    ).toBe(false)
  })

  test("leaves the existing message API and composer text schema backward compatible", () => {
    expect(composerRequest.parse({ text: "Hello" })).toEqual({ text: "Hello" })
    expect(
      createMessageRequest.safeParse({
        ...envelope,
        zaloAccountContent: { kind: "link", url: "https://example.com/" },
      }).success,
    ).toBe(false)
  })

  test("accepts only a CRM message pointer for forwarding", () => {
    const source = {
      conversationId: "91",
      messageId: "81",
      messageCreatedAt: new Date("2026-01-01T00:00:00Z"),
    }
    const request = { ...envelope, zaloAccountForward: source }
    expect(composerRequest.parse(request)).toEqual(request)
    expect(
      composerRequest.safeParse({
        ...envelope,
        zaloAccountForward: { ...source, providerMessageId: "10" },
      }).success,
    ).toBe(false)
  })
})
