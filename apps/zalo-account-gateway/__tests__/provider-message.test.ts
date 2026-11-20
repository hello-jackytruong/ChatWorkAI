import { describe, expect, it } from "vitest"
import { normalizeProviderMessage } from "../src/runtime/provider-message"

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

  it("classifies groups before direct-message parsing", () => {
    expect(
      normalizeProviderMessage({ ...base, type: 1, threadId: "group-1" }),
    ).toEqual({
      kind: "group",
      threadId: "group-1",
      providerMessageId: "100",
    })
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
