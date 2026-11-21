import { describe, expect, it } from "vitest"
import {
  normalizeProviderGroupActivity,
  normalizeProviderMessage,
} from "../src/runtime/provider-message"

const base = {
  type: 0,
  threadId: "peer-1",
  isSelf: false,
  data: {
    msgId: "100",
    cliMsgId: "200",
    uidFrom: "peer-1",
    idTo: "self-1",
    dName: "Customer",
    ts: "1763596800000",
    msgType: "webchat",
    content: "hello",
  },
}

describe("normalizeProviderMessage", () => {
  it("normalizes a direct text and quote without losing provider identity", () => {
    const result = normalizeProviderMessage({
      ...base,
      data: {
        ...base.data,
        quote: {
          msgId: "90",
          cliMsgId: "91",
          ownerId: "self-1",
          cliMsgType: 1,
          ts: 1_763_596_700_000,
          msg: "earlier",
        },
      },
    })

    expect(result).toEqual({
      kind: "direct",
      message: expect.objectContaining({
        providerMessageId: "100",
        clientMessageId: "200",
        threadId: "peer-1",
        senderId: "peer-1",
        recipientId: "self-1",
        text: "hello",
        quote: expect.objectContaining({ providerMessageId: "90" }),
      }),
    })
  })

  it("extracts an image URL from a provider attachment", () => {
    const result = normalizeProviderMessage({
      ...base,
      data: {
        ...base.data,
        msgType: "photo",
        content: {
          title: "photo.jpg",
          oriUrl: "https://cdn.example.test/photo.jpg",
        },
      },
    })

    expect(result).toMatchObject({
      kind: "direct",
      message: {
        attachments: [
          {
            kind: "image",
            name: "photo.jpg",
            url: "https://cdn.example.test/photo.jpg",
          },
        ],
      },
    })
  })

  it("keeps group identity and sender content separate from direct recipients", () => {
    expect(
      normalizeProviderMessage({ ...base, type: 1, threadId: "group-1" }),
    ).toEqual({
      kind: "group",
      threadId: "group-1",
      providerMessageId: "100",
      message: expect.objectContaining({
        threadId: "group-1",
        threadType: "group",
        senderId: "peer-1",
        senderName: "Customer",
        text: "hello",
        mentions: [],
      }),
    })
  })

  it("preserves group mention offsets and self-echo identity", () => {
    const result = normalizeProviderMessage({
      ...base,
      type: 1,
      threadId: "group-1",
      isSelf: true,
      data: {
        ...base.data,
        content: "  @Bot hi",
        mentions: [{ uid: "self-1", pos: 2, len: 4 }],
      },
    })
    expect(result).toMatchObject({
      kind: "group",
      message: {
        providerMessageId: "100",
        clientMessageId: "200",
        isSelf: true,
        text: "  @Bot hi",
        mentions: [{ uid: "self-1", offset: 2, length: 4, type: 0 }],
      },
    })
  })

  it("rejects malformed group mentions instead of guessing automation intent", () => {
    for (const mentions of [
      [{ uid: "self-1", pos: -1, len: 4 }],
      [{ uid: "self-1", pos: 0, len: 99 }],
      [{ uid: "self-1", pos: "0", len: 1 }],
      "invalid",
    ]) {
      expect(
        normalizeProviderMessage({
          ...base,
          type: 1,
          data: { ...base.data, mentions },
        }),
      ).toEqual({ kind: "unsupported", reason: "invalid_group_message" })
    }
  })

  it("keeps group attachments and quote IDs without retaining raw provider data", () => {
    expect(
      normalizeProviderMessage({
        ...base,
        type: 1,
        threadId: "group-1",
        data: {
          ...base.data,
          msgType: "file",
          content: {
            href: "https://cdn.example.test/a.pdf",
            title: "a.pdf",
            secret: "ignored",
          },
          quote: {
            msgId: "90",
            cliMsgId: "91",
            ownerId: "peer-2",
            msgType: "webchat",
            ts: 10,
            msg: "earlier",
          },
        },
      }),
    ).toMatchObject({
      kind: "group",
      message: {
        attachments: [
          {
            kind: "file",
            name: "a.pdf",
            url: "https://cdn.example.test/a.pdf",
          },
        ],
        quote: {
          providerMessageId: "90",
          clientMessageId: "91",
          senderId: "peer-2",
        },
      },
    })
  })

  it("rejects group messages with missing identity, unsupported content, or oversized text", () => {
    for (const data of [
      { ...base.data, msgId: undefined },
      { ...base.data, uidFrom: undefined },
      { ...base.data, ts: -1 },
      { ...base.data, content: "x".repeat(20_001) },
      { ...base.data, msgType: "poll", content: { pollId: "p1" } },
    ]) {
      expect(normalizeProviderMessage({ ...base, type: 1, data }).kind).toBe(
        "unsupported",
      )
    }
  })

  it("retains metadata refresh identity even for unsupported group content", () => {
    const input = {
      ...base,
      type: 1,
      data: { ...base.data, content: { pollId: "p1" } },
    }
    expect(normalizeProviderMessage(input).kind).toBe("unsupported")
    expect(normalizeProviderGroupActivity(input)).toEqual({
      threadId: "peer-1",
      providerMessageId: "100",
    })
    expect(normalizeProviderGroupActivity(base)).toBeUndefined()
  })

  it("uses extension mentions only when direct mentions are absent", () => {
    const mention = { uid: "-1", pos: 0, len: 4, type: 1 }
    for (const ext of [
      { mentions: [mention] },
      JSON.stringify({ mentions: [mention] }),
    ]) {
      const input = {
        ...base,
        type: 1,
        data: { ...base.data, propertyExt: { ext } },
      }
      expect(normalizeProviderMessage(input)).toMatchObject({
        kind: "group",
        message: {
          mentions: [{ uid: "-1", offset: 0, length: 4, type: 1 }],
        },
      })
      expect(
        normalizeProviderMessage({
          ...input,
          data: { ...input.data, mentions: [] },
        }),
      ).toMatchObject({ kind: "group", message: { mentions: [] } })
    }
  })

  it("rejects malformed or unsupported content without fabricating a message", () => {
    expect(
      normalizeProviderMessage({
        ...base,
        data: { ...base.data, msgType: "poll", content: { pollId: "p1" } },
      }),
    ).toEqual({ kind: "unsupported", reason: "unsupported_content" })
  })
})
