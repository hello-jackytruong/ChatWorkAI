import { describe, expect, it } from "vitest"
import { normalizeProviderMessage } from "../src/runtime/provider-message"

const base = {
  type: 0,
  threadId: "peer",
  isSelf: false,
  data: {
    msgId: "m1",
    uidFrom: "peer",
    idTo: "self",
    ts: 123,
    msgType: "poll",
    content: { secret: "https://secret.test" },
  },
}
describe("bounded provider evidence", () => {
  it("emits only safe identity for unsupported content when enabled", () => {
    const result = normalizeProviderMessage(base, {
      ownUid: "self",
      messageIntegrityEnabled: true,
    })
    expect(result).toMatchObject({
      kind: "direct",
      message: {
        schemaVersion: 1,
        unsupported: { reason: "unsupported_content" },
        attachments: [],
      },
    })
    expect(JSON.stringify(result)).not.toContain("secret")
  })
  it("rejects unsafe numeric identity and conflicting self evidence", () => {
    expect(
      normalizeProviderMessage({
        ...base,
        data: { ...base.data, msgId: Number.MAX_SAFE_INTEGER + 1 },
      }).kind,
    ).toBe("unsupported")
    expect(
      normalizeProviderMessage(
        { ...base, isSelf: true },
        { ownUid: "self", messageIntegrityEnabled: true },
      ),
    ).toMatchObject({ kind: "unsupported", reason: "invalid_identity" })
  })
  it("never throws on overlong text, malformed JSON or hostile getters", () => {
    expect(() =>
      normalizeProviderMessage({
        ...base,
        data: { ...base.data, content: "x".repeat(65_537) },
      }),
    ).not.toThrow()
    expect(() =>
      normalizeProviderMessage({
        get type() {
          throw new Error("secret")
        },
      }),
    ).not.toThrow()
  })
})

it("supports unknown-schema safe headers while omitting unknown bodies", () => {
  const result = normalizeProviderMessage(
    { ...base, schemaVersion: 2 } as typeof base,
    { ownUid: "self", messageIntegrityEnabled: true },
  )
  expect(result).toMatchObject({
    kind: "direct",
    message: { unsupported: { reason: "unsupported_schema" } },
  })
  expect(JSON.stringify(result)).not.toContain("secret")
})
it("keeps legacy unsupported traffic silent and exact supported self identities", () => {
  expect(normalizeProviderMessage(base)).toMatchObject({ kind: "unsupported" })
  expect(
    normalizeProviderMessage(
      {
        ...base,
        isSelf: true,
        data: {
          ...base.data,
          uidFrom: "self",
          idTo: "peer",
          msgType: "webchat",
          content: "hello",
        },
      },
      { ownUid: "self", messageIntegrityEnabled: true },
    ),
  ).toMatchObject({
    kind: "direct",
    message: { senderId: "self", recipientId: "peer", isSelf: true },
  })
})

it.each([
  false,
  true,
])("preserves supported text and URLs longer than identity bounds with gate=%s", (enabled) => {
  const text = "a".repeat(2000)
  const textResult = normalizeProviderMessage(
    { ...base, data: { ...base.data, msgType: "webchat", content: text } },
    { ownUid: "self", messageIntegrityEnabled: enabled },
  )
  expect(textResult).toMatchObject({ kind: "direct", message: { text } })
  const url = `https://cdn.test/${"a".repeat(1000)}.jpg`
  const mediaResult = normalizeProviderMessage(
    {
      ...base,
      data: { ...base.data, msgType: "photo", content: { oriUrl: url } },
    },
    { ownUid: "self", messageIntegrityEnabled: enabled },
  )
  expect(mediaResult).toMatchObject({
    kind: "direct",
    message: { attachments: [{ kind: "image", url }] },
  })
})

it.each([
  false,
  true,
])("preserves long supported URLs with gate=%s", (enabled) => {
  const url = `https://cdn.test/${"a".repeat(1000)}.jpg`
  expect(
    normalizeProviderMessage(
      {
        ...base,
        data: { ...base.data, msgType: "photo", content: { oriUrl: url } },
      },
      { ownUid: "self", messageIntegrityEnabled: enabled },
    ),
  ).toMatchObject({
    kind: "direct",
    message: { attachments: [{ kind: "image", url }] },
  })
})
