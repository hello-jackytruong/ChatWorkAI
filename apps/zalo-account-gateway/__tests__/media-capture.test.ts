import {
  zaloAccountOutboundMessageSchema,
  zaloAccountTransportEventSchema,
} from "@chatbotx.io/sdk"
import { describe, expect, it } from "vitest"
import { normalizeProviderMessage } from "../src/runtime/provider-message"

const base = {
  threadId: "thread",
  isSelf: true,
  data: { msgId: "msg", uidFrom: "self", idTo: "peer", ts: 10 },
}
describe("inbound media capture", () => {
  for (const type of [0, 1]) {
    for (const kind of ["video", "voice", "gif", "sticker"]) {
      it(`serializes descriptor-only ${kind} in thread ${type}`, () => {
        const normalized = normalizeProviderMessage({
          ...base,
          type,
          data: {
            ...base.data,
            msgType: kind,
            content: {
              params: JSON.stringify({
                url: "https://cdn.example.test/original?token=private",
                id: "resource",
                width: 200,
                height: 100,
                duration: 3000,
                mimeType: "video/mp4",
                size: 100,
              }),
            },
          },
        })
        expect(normalized.kind).toBe(type === 0 ? "direct" : "group")
        if (normalized.kind === "unsupported") {
          return
        }
        expect(normalized.message).toMatchObject({
          attachments: [],
          mediaResources: [
            {
              kind: kind === "voice" ? "audio" : kind,
              role: "original",
              slot: "original",
              providerResourceId: "resource",
              width: 200,
              height: 100,
              durationMs: 3000,
            },
          ],
        })
        const event = {
          version: 1,
          eventId: "event",
          route: {
            kind: "account",
            workspaceId: "w",
            accountId: "a",
            inboxId: "i",
          },
          epoch: 1,
          fenceToken: "1",
          occurredAt: "2026-11-23T00:00:00.000Z",
          kind: type === 0 ? "direct_message" : "group_message",
          ...(type === 1 ? { accountPolicyEpoch: 0, groupPolicyEpoch: 0 } : {}),
          payload: normalized.message,
        }
        expect(
          zaloAccountTransportEventSchema.parse(
            JSON.parse(JSON.stringify(event)),
          ),
        ).toEqual(event)
      })
    }
  }
  it("records missing source and never crawls bank or link webpages", () => {
    const missing = normalizeProviderMessage({
      ...base,
      type: 0,
      data: { ...base.data, msgType: "video", content: {} },
    })
    expect(missing).toMatchObject({
      kind: "direct",
      message: {
        mediaResources: [{ kind: "video", sourceMissing: "source_missing" }],
      },
    })
    for (const msgType of ["bank", "link"]) {
      expect(
        normalizeProviderMessage({
          ...base,
          type: 0,
          data: {
            ...base.data,
            msgType,
            content: {
              href: "https://bank.example.test",
              image: "https://bank.example.test/logo",
            },
          },
        }).kind,
      ).toBe("unsupported")
    }
  })
  it("keeps inbound-only kinds outside outgoing sends", () => {
    for (const kind of ["video", "audio", "gif", "sticker"]) {
      expect(
        zaloAccountOutboundMessageSchema.safeParse({
          recipientId: "peer",
          attachments: [{ kind, url: "https://cdn.example.test/a" }],
        }).success,
      ).toBe(false)
    }
  })
})

it("bounds explicit card media and skips nested webpage URLs", () => {
  const result = normalizeProviderMessage({
    ...base,
    type: 0,
    data: {
      ...base.data,
      msgType: "card",
      content: {
        media: Array.from({ length: 30 }, (_, i) => ({
          type: "image",
          url: `https://cdn.example.test/${i}.png`,
        })),
        unknown: { url: "https://never.example.test" },
      },
    },
  })
  expect(result.kind).toBe("direct")
  if (result.kind === "direct") {
    expect(result.message.mediaResources).toHaveLength(12)
    expect(result.message.mediaResources?.[0]).toMatchObject({
      role: "card_image",
      slot: "card_image:0",
    })
  }
})

it.each([
  0, 1,
])("preserves descriptor-only media with integrity enabled in thread %s", (type) => {
  const result = normalizeProviderMessage(
    {
      ...base,
      type,
      threadId: type === 0 ? "peer" : "group",
      data: {
        ...base.data,
        msgType: "video",
        content: { url: "https://cdn.example.test/original" },
      },
    },
    { ownUid: "self", messageIntegrityEnabled: true },
  )
  expect(result).toMatchObject({
    kind: type === 0 ? "direct" : "group",
    message: {
      schemaVersion: 1,
      attachments: [],
      mediaResources: [{ kind: "video", role: "original" }],
    },
  })
  if (result.kind !== "unsupported") {
    expect(result.message.unsupported).toBeUndefined()
  }
})
