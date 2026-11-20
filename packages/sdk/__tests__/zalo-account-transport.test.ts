import {
  parseZaloAccountCommandEnvelope,
  zaloAccountLabelSnapshotSchema,
  zaloAccountTransportEventSchema,
} from "@chatbotx.io/sdk"
import { describe, expect, it } from "vitest"

const accountRoute = {
  kind: "account" as const,
  workspaceId: "workspace-1",
  accountId: "account-1",
  inboxId: "inbox-1",
}
const EXPIRED_PATTERN = /expired/i

describe("Zalo Account transport contracts", () => {
  it("accepts a live command with an immutable workspace/account/inbox route", () => {
    const command = {
      version: 1 as const,
      commandId: "command-1",
      kind: "reconnect" as const,
      route: accountRoute,
      createdAt: "2026-11-20T02:00:00.000Z",
      expiresAt: "2026-11-20T02:01:00.000Z",
    }

    expect(
      parseZaloAccountCommandEnvelope(command, {
        now: new Date("2026-11-20T02:00:30.000Z"),
      }),
    ).toEqual(command)
  })

  it("rejects an expired command before it reaches a gateway", () => {
    expect(() =>
      parseZaloAccountCommandEnvelope(
        {
          version: 1,
          commandId: "command-expired",
          kind: "reconnect",
          route: accountRoute,
          createdAt: "2026-11-20T02:00:00.000Z",
          expiresAt: "2026-11-20T02:01:00.000Z",
        },
        { now: new Date("2026-11-20T02:01:01.000Z") },
      ),
    ).toThrow(EXPIRED_PATTERN)
  })

  it("requires a session route for QR startup and an account route for reconnect", () => {
    expect(() =>
      parseZaloAccountCommandEnvelope(
        {
          version: 1,
          commandId: "command-qr",
          kind: "start_qr",
          route: accountRoute,
          createdAt: "2026-11-20T02:00:00.000Z",
          expiresAt: "2026-11-20T02:01:00.000Z",
        },
        { now: new Date("2026-11-20T02:00:10.000Z") },
      ),
    ).toThrow()

    expect(() =>
      parseZaloAccountCommandEnvelope(
        {
          version: 1,
          commandId: "command-reconnect",
          kind: "reconnect",
          route: {
            kind: "connect_session",
            workspaceId: "workspace-1",
            sessionId: "session-1",
          },
          createdAt: "2026-11-20T02:00:00.000Z",
          expiresAt: "2026-11-20T02:01:00.000Z",
        },
        { now: new Date("2026-11-20T02:00:10.000Z") },
      ),
    ).toThrow()
  })

  it("keeps authorization and QR bytes out of ordinary lifecycle events", () => {
    const base = {
      version: 1 as const,
      eventId: "event-1",
      route: accountRoute,
      epoch: 1,
      fenceToken: "7",
      occurredAt: "2026-11-20T02:00:00.000Z",
    }

    expect(
      zaloAccountTransportEventSchema.safeParse({
        ...base,
        kind: "lifecycle",
        payload: { type: "connected", zaloUid: "uid-1" },
        auth: { cookie: "secret" },
      }).success,
    ).toBe(false)
    expect(
      zaloAccountTransportEventSchema.safeParse({
        ...base,
        kind: "lifecycle",
        payload: {
          type: "qr_generated",
          imageDataUrl: "data:image/png;base64,QUJD",
        },
      }).success,
    ).toBe(false)
  })

  it("accepts only encrypted secret envelopes on the secret event path", () => {
    expect(
      zaloAccountTransportEventSchema.safeParse({
        version: 1,
        eventId: "event-secret",
        route: {
          kind: "connect_session",
          workspaceId: "workspace-1",
          sessionId: "session-1",
        },
        epoch: 1,
        fenceToken: "8",
        occurredAt: "2026-11-20T02:00:00.000Z",
        kind: "secret",
        secretKind: "authorization_obtained",
        aad: "zalo-account:workspace-1:session-1:command-1:1:8",
        ciphertext: {
          v: 1,
          kid: "active",
          iv: "000000000000000000000000",
          text: "aa",
          tag: "00000000000000000000000000000000",
          aad: "zalo-account:workspace-1:session-1:command-1:1:8",
        },
      }).success,
    ).toBe(true)

    expect(
      zaloAccountTransportEventSchema.safeParse({
        version: 1,
        eventId: "event-plaintext",
        route: {
          kind: "connect_session",
          workspaceId: "workspace-1",
          sessionId: "session-1",
        },
        epoch: 1,
        fenceToken: "8",
        occurredAt: "2026-11-20T02:00:00.000Z",
        kind: "secret",
        secretKind: "authorization_obtained",
        auth: { cookie: [{ key: "secret", value: "value" }] },
      }).success,
    ).toBe(false)
  })

  it("validates complete label snapshots and rejects duplicate definitions", () => {
    const label = {
      id: 1,
      text: "Priority",
      textKey: "priority",
      conversations: ["user-1"],
      color: "#0068FF",
      offset: 0,
      emoji: "",
      createTime: 1,
    }
    expect(
      zaloAccountLabelSnapshotSchema.safeParse({
        labelData: [label],
        version: 4,
        lastUpdateTime: 10,
      }).success,
    ).toBe(true)
    expect(
      zaloAccountLabelSnapshotSchema.safeParse({
        labelData: [label, { ...label, text: "Duplicate" }],
        version: 4,
        lastUpdateTime: 10,
      }).success,
    ).toBe(false)
  })
})
