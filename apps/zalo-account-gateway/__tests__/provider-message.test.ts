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
  it("carries the scoped sticker identity from group and own echoes into private capture", () => {
    const data = {
      ...base.data,
      msgType: "chat.sticker",
      content: { sticker_id: 892, cate_id: 0, type: 7 },
    }
    const expected = {
      richContent: {
        kind: "sticker",
        stickerId: "892",
        categoryId: "0",
        stickerType: 7,
      },
      mediaResources: [
        {
          kind: "sticker",
          role: "original",
          providerResourceId: "892",
          sourceMissing: "source_missing",
        },
      ],
    }
    expect(normalizeProviderMessage({ ...base, type: 1, data })).toMatchObject({
      kind: "group",
      message: expected,
    })
    expect(
      normalizeProviderMessage(
        {
          ...base,
          isSelf: true,
          data: { ...data, uidFrom: "self-1", idTo: "peer-1" },
        },
        { ownUid: "self-1" },
      ),
    ).toMatchObject({
      kind: "direct",
      message: { ...expected, isSelf: true },
    })
  })

  it.each([
    [
      "recommened.link",
      {
        href: "https://example.test/page",
        thumb: "https://cdn.example.test/thumb.png",
        title: "Article",
      },
      { kind: "link", url: "https://example.test/page", title: "Article" },
    ],
    [
      "recommended.user",
      {
        params: JSON.stringify({
          uid: "42",
          userName: "Kim",
          phone: "2025550101",
        }),
      },
      { kind: "contact", userId: "42", name: "Kim", phone: "2025550101" },
    ],
    [
      "show.location",
      { title: "Office", params: { latitude: 10.5, longitude: 106.5 } },
      { kind: "location", title: "Office", latitude: 10.5, longitude: 106.5 },
    ],
    [
      "zinstant.bankcard",
      {
        params: {
          bankName: "Example Bank",
          accountNumber: "00123",
          amount: "50000",
          item: { data_url: "https://example.test/template.html" },
        },
      },
      {
        kind: "bank",
        bankName: "Example Bank",
        accountNumber: "00123",
        amount: 50_000,
      },
    ],
    [
      "recommended.calltime",
      { params: { callType: "video", callDuration: 39 } },
      {
        kind: "call",
        direction: "incoming",
        medium: "video",
        status: "answered",
        durationMs: 39_000,
      },
    ],
    [
      "recommened.misscall",
      { params: "{broken" },
      { kind: "call", direction: "incoming", status: "missed" },
    ],
    [
      "",
      {
        description: JSON.stringify({
          qrCodeUrl: "https://cdn.example.test/qr.png",
        }),
        title: "Payment QR",
      },
      { kind: "qr", title: "Payment QR" },
    ],
  ])("uses rich action and shape for %j even in a shared message type", (action, content, richContent) => {
    const data = {
      ...base.data,
      msgType: "share.recommened",
      content: { action, ...content, raw: "secret" },
    }
    const direct = normalizeProviderMessage(
      { ...base, data },
      { ownUid: "self-1" },
    )
    const group = normalizeProviderMessage(
      { ...base, type: 1, threadId: "group-1", data },
      { ownUid: "self-1" },
    )
    expect(direct).toMatchObject({ kind: "direct", message: { richContent } })
    expect(group).toMatchObject({ kind: "group", message: { richContent } })
    expect(JSON.stringify({ direct, group })).not.toContain("secret")
    expect(JSON.stringify({ direct, group })).not.toContain("template.html")
    if (action === "recommened.link") {
      expect(direct).toMatchObject({
        message: {
          text: "Article",
          mediaResources: [{ slot: "link_preview", role: "card_image" }],
        },
      })
    }
    if (action === "") {
      expect(group).toMatchObject({
        message: { mediaResources: [{ slot: "qr_image", role: "card_image" }] },
      })
    }
  })

  it("keeps the untrimmed text, overlapping UTF-16 ranges and numeric TTL for rich own-echo", () => {
    const result = normalizeProviderMessage(
      {
        ...base,
        isSelf: true,
        data: {
          ...base.data,
          uidFrom: "self-1",
          idTo: "peer-1",
          ttl: 60_000,
          content: {
            action: "rtf",
            title: "  😀 hi",
            params: JSON.stringify({
              styles: [
                { start: 2, len: 5, st: "b" },
                { start: 2, len: 2, st: "i" },
                { start: 3, len: 1, st: "u" },
                { start: 5, len: 25, st: "s" },
                { start: 5, len: 2, st: "c_f27806" },
                { start: 5, len: 2, st: "f_18" },
                { start: 5, len: 2, st: "lst_1" },
              ],
            }),
          },
        },
      },
      { ownUid: "self-1" },
    )
    expect(result).toMatchObject({
      kind: "direct",
      message: {
        isSelf: true,
        text: "  😀 hi",
        providerTtl: 60_000,
        richContent: {
          kind: "styledText",
          spans: [
            { offset: 2, length: 5, style: "b" },
            { offset: 2, length: 2, style: "i" },
            { offset: 5, length: 2, style: "c_f27806" },
            { offset: 5, length: 2, style: "f_18" },
            { offset: 5, length: 2, style: "lst_1" },
          ],
        },
      },
    })
  })

  it("keeps legacy or malformed presentation as safe placeholder or plain text", () => {
    for (const content of [
      { action: "recommended.link", href: "javascript:alert(1)" },
      { action: "recommended.link", href: "https://user:secret@example.test/" },
      {
        action: "unsupported.variant",
        href: "https://example.test/",
        title: "Unrecognized",
      },
    ]) {
      expect(
        normalizeProviderMessage(
          {
            ...base,
            data: { ...base.data, msgType: "share.recommended", content },
          },
          { messageIntegrityEnabled: true },
        ),
      ).toMatchObject({
        kind: "direct",
        message: { unsupported: { reason: "unsupported_content" } },
      })
    }
    const result = normalizeProviderMessage({
      ...base,
      data: {
        ...base.data,
        ttl: 0,
        content: { action: "rtf", title: "plain fallback", params: "invalid" },
      },
    })
    expect(result).toMatchObject({
      kind: "direct",
      message: { text: "plain fallback", providerTtl: 0 },
    })
    expect(result).not.toHaveProperty("message.richContent")
    expect(normalizeProviderMessage(base)).not.toHaveProperty(
      "message.providerTtl",
    )
  })

  it("keeps descriptor-only video, audio, and animated GIF in archive slots", () => {
    for (const [msgType, kind] of [
      ["chat.video", "video"],
      ["chat.voice", "audio"],
      ["chat.gif", "gif"],
    ]) {
      const mediaResources = [
        {
          kind,
          role: "original",
          slot: "original",
          durationMs: 9000,
          ...(kind === "gif" ? { animated: true } : {}),
        },
        { kind: "image", role: "poster", slot: "poster" },
      ]
      expect(
        normalizeProviderMessage({
          ...base,
          data: {
            ...base.data,
            msgType,
            content: {
              url: "https://cdn.example.test/media",
              posterUrl: "https://cdn.example.test/poster",
              durationMs: "9000",
            },
          },
        }),
      ).toMatchObject({
        kind: "direct",
        message: { attachments: [], mediaResources },
      })
    }
  })

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
