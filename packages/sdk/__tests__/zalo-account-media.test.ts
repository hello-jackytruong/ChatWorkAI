import { expect, it } from "vitest"
import {
  zaloAccountCommandEnvelopeSchema,
  zaloAccountCommandResultSchema,
  zaloAccountDirectMessageSchema,
  zaloAccountGroupMessageSchema,
  zaloAccountMediaResourceSchema,
} from "../src"

const media = {
  kind: "video",
  role: "original",
  slot: "original",
  sourceMissing: "source_missing",
}
const message = {
  providerMessageId: "m",
  threadId: "t",
  senderId: "s",
  recipientId: "r",
  timestampMs: 1,
  msgType: "video",
  isSelf: false,
  mediaResources: [media],
}
it("serializes descriptor-only input without adding unsupported send attachments", () => {
  expect(
    zaloAccountDirectMessageSchema.parse(
      JSON.parse(JSON.stringify({ ...message, threadType: "user" })),
    ),
  ).toMatchObject({ attachments: [], mediaResources: [media] })
  const { recipientId: _, ...group } = message
  expect(
    zaloAccountGroupMessageSchema.parse({ ...group, threadType: "group" }),
  ).toMatchObject({ attachments: [], mediaResources: [media] })
  expect(
    zaloAccountDirectMessageSchema.safeParse({
      ...message,
      threadType: "user",
      mediaResources: new Array(13).fill(media),
    }).success,
  ).toBe(false)
  for (const resource of [
    { ...media, url: "https://cdn.test/a" },
    { ...media, url: undefined, sourceMissing: undefined },
    { ...media, unexpected: "secret" },
    {
      ...media,
      url: "https://name:secret@cdn.test/a",
      sourceMissing: undefined,
    },
  ]) {
    expect(zaloAccountMediaResourceSchema.safeParse(resource).success).toBe(
      false,
    )
  }
})
it("bounds the sticker read command and strict result", () => {
  const command = {
    version: 1,
    commandId: "c",
    createdAt: "2026-11-23T00:00:00Z",
    expiresAt: "2026-11-24T00:00:00Z",
    kind: "get_sticker_resources",
    route: { kind: "account", workspaceId: "w", accountId: "a", inboxId: "i" },
    target: { ownerId: "o", epoch: 1, fenceToken: "1" },
    stickerIds: ["1"],
  }
  expect(zaloAccountCommandEnvelopeSchema.safeParse(command).success).toBe(true)
  expect(
    zaloAccountCommandEnvelopeSchema.safeParse({
      ...command,
      stickerIds: new Array(21).fill("1"),
    }).success,
  ).toBe(false)
  expect(
    zaloAccountCommandResultSchema.safeParse({
      status: "applied",
      result: {
        status: "synced",
        stickerResources: [
          { stickerId: "1", resources: [{ ...media, kind: "sticker" }] },
        ],
      },
    }).success,
  ).toBe(true)
})

it("keeps unsupported placeholders free of media locators", () => {
  const placeholder = {
    ...message,
    schemaVersion: 1,
    unsupported: { reason: "unsupported_content" },
  }
  expect(
    zaloAccountDirectMessageSchema.safeParse({
      ...placeholder,
      threadType: "user",
    }).success,
  ).toBe(false)
  const { recipientId: _, ...group } = placeholder
  expect(
    zaloAccountGroupMessageSchema.safeParse({
      ...group,
      threadType: "group",
    }).success,
  ).toBe(false)
})
