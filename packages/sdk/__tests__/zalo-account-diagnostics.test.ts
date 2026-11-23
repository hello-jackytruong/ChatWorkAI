import { expect, it } from "vitest"
import {
  isZaloAccountSecretEventAadValid,
  zaloAccountSecretEventAad,
  zaloAccountTransportEventSchema,
} from "../src/lib/zalo-account"

const event = {
  version: 1,
  eventId: "event",
  route: { kind: "account", workspaceId: "w", accountId: "a", inboxId: "i" },
  epoch: 1,
  fenceToken: "2",
  socketAttempt: 1,
  sequence: 3,
  occurredAt: "2026-11-23T00:00:00.000Z",
  kind: "lifecycle",
  payload: {
    type: "runtime_diagnostic",
    diagnostics: { phase: "connecting", reconnectCount: 0 },
  },
}
it("accepts bounded diagnostics with complete observation order", () => {
  expect(zaloAccountTransportEventSchema.safeParse(event).success).toBe(true)
})
it("rejects malformed order and secrets in diagnostics", () => {
  expect(
    zaloAccountTransportEventSchema.safeParse({ ...event, sequence: -1 })
      .success,
  ).toBe(false)
  expect(
    zaloAccountTransportEventSchema.safeParse({
      ...event,
      payload: {
        ...event.payload,
        diagnostics: { ...event.payload.diagnostics, cookie: "secret" },
      },
    }).success,
  ).toBe(false)
})

it("binds encrypted secret routing and attempt order while retaining legacy AAD readers", () => {
  const input = {
    route: {
      kind: "account" as const,
      workspaceId: "w",
      accountId: "a",
      inboxId: "i",
    },
    commandId: "command",
    epoch: 2,
    fenceToken: "3",
    eventId: "event",
    socketAttempt: 4,
    sequence: 5,
  }
  const aad = zaloAccountSecretEventAad(input)
  expect(isZaloAccountSecretEventAadValid({ ...input, aad })).toBe(true)
  expect(
    isZaloAccountSecretEventAadValid({ ...input, socketAttempt: 5, aad }),
  ).toBe(false)
  expect(
    isZaloAccountSecretEventAadValid({
      ...input,
      route: { ...input.route, inboxId: "another" },
      aad,
    }),
  ).toBe(false)
  const legacy = { ...input, socketAttempt: undefined, sequence: undefined }
  expect(
    isZaloAccountSecretEventAadValid({
      ...legacy,
      aad: zaloAccountSecretEventAad(legacy),
    }),
  ).toBe(true)
})
