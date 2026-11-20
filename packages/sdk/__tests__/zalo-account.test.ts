import {
  zaloAccountAuthorizationEventSchema,
  zaloAccountAuthSchema,
  zaloAccountLifecycleEventSchema,
  zaloAccountRuntimeRefSchema,
} from "@chatbotx.io/sdk"
import { describe, expect, it } from "vitest"

const auth = {
  authType: "custom" as const,
  cookie: [
    { key: "zpw_sek", value: "secret", domain: ".zalo.me", path: "/" },
    { key: "zpw_uid", value: "123", domain: ".zalo.me", path: "/" },
  ],
  imei: "imei-1",
  userAgent: "Mozilla/5.0",
  zaloUid: "zalo-user-1",
}

describe("zaloAccountAuthSchema", () => {
  it("accepts the validated personal-account session returned after QR login", () => {
    expect(zaloAccountAuthSchema.parse(auth)).toEqual(auth)
  })

  it.each([
    { ...auth, cookie: "zpw_sek=secret" },
    { ...auth, cookie: null },
    { ...auth, cookie: [{ key: "zpw_sek" }] },
    { ...auth, cookie: {} },
    { ...auth, imei: "" },
    { ...auth, userAgent: "" },
    { ...auth, zaloUid: "" },
    { ...auth, zaloUid: undefined },
  ])("rejects malformed or incomplete authorization %#", (value) => {
    expect(zaloAccountAuthSchema.safeParse(value).success).toBe(false)
  })
})

describe("zaloAccount runtime contracts", () => {
  it("supports connect-session and durable-account runtime subjects", () => {
    expect(
      zaloAccountRuntimeRefSchema.parse({
        kind: "connect_session",
        id: "session-1",
      }),
    ).toEqual({ kind: "connect_session", id: "session-1" })
    expect(
      zaloAccountRuntimeRefSchema.parse({ kind: "account", id: "account-1" }),
    ).toEqual({ kind: "account", id: "account-1" })
  })

  it.each([
    {
      type: "qr_generated",
      runtime: { kind: "connect_session", id: "session-1" },
      epoch: 1,
      fenceToken: "2",
      imageDataUrl: "data:image/png;base64,QUJD",
      expiresAt: "2026-11-19T09:00:00.000Z",
    },
    {
      type: "qr_scanned",
      runtime: { kind: "connect_session", id: "session-1" },
      epoch: 1,
      fenceToken: "2",
      displayName: "Jacky",
      avatarUrl: "https://example.com/avatar.jpg",
    },
    {
      type: "connected",
      runtime: { kind: "account", id: "account-1" },
      epoch: 2,
      fenceToken: "3",
      zaloUid: "zalo-user-1",
    },
    {
      type: "closed",
      runtime: { kind: "account", id: "account-1" },
      epoch: 2,
      fenceToken: "3",
      reason: "passive",
    },
    {
      type: "reauthorization_required",
      runtime: { kind: "account", id: "account-1" },
      epoch: 2,
      fenceToken: "3",
      reason: "session_unstable",
    },
  ])("accepts non-secret lifecycle event %#", (event) => {
    expect(zaloAccountLifecycleEventSchema.safeParse(event).success).toBe(true)
  })

  it("keeps the secret-bearing authorization event on a separate schema", () => {
    const event = {
      type: "authorization_obtained" as const,
      runtime: { kind: "connect_session" as const, id: "session-1" },
      epoch: 1,
      fenceToken: "2",
      auth,
      displayName: "Jacky",
    }

    expect(zaloAccountAuthorizationEventSchema.parse(event)).toEqual(event)
    expect(zaloAccountLifecycleEventSchema.safeParse(event).success).toBe(false)
  })
})
