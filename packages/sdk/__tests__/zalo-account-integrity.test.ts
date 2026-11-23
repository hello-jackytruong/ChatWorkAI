import { describe, expect, it, vi } from "vitest"
import {
  getZaloAccountErrorInfo,
  getZaloAccountErrorMessage,
  getZaloAccountMessageEvidence,
  getZaloAccountSendAttemptRevision,
  isNewerZaloAccountRuntimeEvent,
  isZaloAccountSecretEventAadValid,
  parseZaloAccountCommandEnvelope,
  ZaloAccountPreDispatchError,
  zaloAccountCommandEnvelopeSchema,
  zaloAccountCommandResultSchema,
  zaloAccountDirectMessageSchema,
  zaloAccountErrorInfoSchema,
  zaloAccountFriendSyncSchema,
  zaloAccountGroupMessageSchema,
  zaloAccountLabelSnapshotSchema,
  zaloAccountOutboundMessageSchema,
  zaloAccountSecretEventAad,
  zaloAccountThreadEventSchema,
  zaloAccountTransportEventSchema,
  zaloAccountTransportKeys,
} from "../src/lib/zalo-account"

const direct = {
  providerMessageId: "m1",
  threadId: "u1",
  threadType: "user",
  senderId: "u1",
  recipientId: "own",
  timestampMs: 1000,
  msgType: "chat.sticker",
  isSelf: false,
  attachments: [],
}

describe("Zalo message integrity contracts", () => {
  it("reads legacy messages without injecting new wire fields", () => {
    expect(
      zaloAccountDirectMessageSchema.parse({ ...direct, text: "hello" }),
    ).not.toHaveProperty("schemaVersion")
  })
  it("accepts a bounded unsupported marker without synthetic customer text", () => {
    expect(
      zaloAccountDirectMessageSchema.safeParse({
        ...direct,
        schemaVersion: 1,
        unsupported: { reason: "unsupported_content" },
      }).success,
    ).toBe(true)
  })
  it("rejects raw provider body smuggled into an unsupported marker", () => {
    expect(
      zaloAccountDirectMessageSchema.safeParse({
        ...direct,
        schemaVersion: 1,
        unsupported: { reason: "unsupported_content", raw: "SECRET" },
      }).success,
    ).toBe(false)
  })
  it("turns an unknown stored schema version into safe unsupported evidence", () => {
    expect(
      getZaloAccountMessageEvidence({
        zaloAccount: {
          schemaVersion: 9,
          unsupported: { reason: "unsupported_content", raw: "SECRET" },
        },
      }),
    ).toEqual({
      schemaVersion: 1,
      unsupported: { reason: "unsupported_schema" },
    })
  })
  it("does not expose arbitrary provider error messages", () => {
    const info = getZaloAccountErrorInfo(
      new Error("SECRET https://private.invalid/token"),
    )
    expect(getZaloAccountErrorMessage(info)).not.toContain("SECRET")
    expect(info.safeAction).toBe("inspect")
  })
  it("retains structured pre-dispatch cooldown metadata", () => {
    const error = new ZaloAccountPreDispatchError("legacy message", {
      code: "rate_limited",
      phase: "admission",
      retryAfterMs: 500,
      safeAction: "new_attempt",
    })
    expect(getZaloAccountErrorInfo(error)).toEqual({
      code: "rate_limited",
      phase: "admission",
      retryAfterMs: 500,
      safeAction: "new_attempt",
    })
    expect(error.message).toBe("legacy message")
  })
})

describe("Zalo integrity error projections", () => {
  it.each([
    null,
    undefined,
    "SECRET",
    123,
    { errorInfo: { code: "raw_error", message: "SECRET" } },
    {
      errorInfo: {
        code: "rate_limited",
        phase: "admission",
        safeAction: "new_attempt",
        retryAfterMs: 0,
      },
    },
  ])("safely handles untrusted error metadata %#", (input) => {
    expect(getZaloAccountErrorInfo(input)).toEqual({
      code: "internal_error",
      phase: "dispatch",
      safeAction: "inspect",
    })
  })
  it("keeps legacy pre-dispatch failures retryable and ambiguous writes inspect-only", () => {
    expect(
      getZaloAccountErrorInfo(new ZaloAccountPreDispatchError("SECRET")),
    ).toEqual({
      code: "pre_dispatch_failed",
      phase: "validation",
      safeAction: "new_attempt",
    })
    expect(
      getZaloAccountErrorInfo({ code: "zaloSendUnknown", message: "SECRET" }),
    ).toEqual({
      code: "send_unknown",
      phase: "dispatch",
      safeAction: "inspect",
    })
  })
  it.each(
    zaloAccountErrorInfoSchema.shape.code.options,
  )("projects a safe fixed message for %s", (code) => {
    const info = {
      code,
      phase: "dispatch" as const,
      safeAction: "inspect" as const,
    }
    const message = getZaloAccountErrorMessage(info)
    expect(typeof message).toBe("string")
    expect(message.length).toBeGreaterThan(10)
    expect(message).not.toContain("SECRET")
    expect(getZaloAccountErrorInfo(info)).toEqual(info)
  })
  it.each([
    -1,
    0,
    0.5,
    86_400_001,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects an unbounded or invalid retry delay %s", (retryAfterMs) => {
    expect(
      zaloAccountErrorInfoSchema.safeParse({
        code: "rate_limited",
        phase: "admission",
        safeAction: "new_attempt",
        retryAfterMs,
      }).success,
    ).toBe(false)
  })
  it("accepts optional bounded metadata only on proven failed command outcomes", () => {
    const errorInfo = {
      code: "admission_paused",
      phase: "admission",
      safeAction: "new_attempt",
      retryAfterMs: 1000,
    }
    expect(
      zaloAccountCommandResultSchema.parse({
        status: "failed",
        error: "legacy",
      }),
    ).toEqual({ status: "failed", error: "legacy" })
    expect(
      zaloAccountCommandResultSchema.parse({
        status: "failed",
        error: "legacy",
        errorInfo,
      }),
    ).toMatchObject({ errorInfo })
    for (const status of ["unknown", "rejected_stale"]) {
      expect(
        zaloAccountCommandResultSchema.safeParse({ status, errorInfo }).success,
      ).toBe(false)
    }
    expect(
      zaloAccountCommandResultSchema.safeParse({
        status: "failed",
        error: "legacy",
        errorInfo: { ...errorInfo, raw: "SECRET" },
      }).success,
    ).toBe(false)
  })
})

describe("stored Zalo evidence compatibility", () => {
  it.each([
    undefined,
    null,
    1,
    "SECRET",
    {},
    { zaloAccount: null },
    { zaloAccount: "SECRET" },
    { zaloAccount: {} },
    { zaloAccount: { schemaVersion: 1 } },
    { zaloAccount: { group: "SECRET" } },
  ])("keeps legacy or unrelated attributes unmarked %#", (attributes) => {
    expect(getZaloAccountMessageEvidence(attributes)).toBeNull()
  })
  it.each([
    "unsupported_content",
    "invalid_content",
    "unsupported_schema",
  ])("reads direct and nested group marker %s", (reason) => {
    for (const zaloAccount of [
      { unsupported: { reason } },
      { schemaVersion: 1, group: { unsupported: { reason } } },
    ]) {
      expect(getZaloAccountMessageEvidence({ zaloAccount })).toEqual({
        schemaVersion: 1,
        unsupported: { reason },
      })
    }
  })
  it("gives direct marker precedence and rejects raw marker fields", () => {
    expect(
      getZaloAccountMessageEvidence({
        zaloAccount: {
          unsupported: { reason: "invalid_content" },
          group: { unsupported: { reason: "unsupported_content" } },
        },
      }),
    ).toEqual({ schemaVersion: 1, unsupported: { reason: "invalid_content" } })
    for (const unsupported of [
      "SECRET",
      { reason: "bad" },
      { reason: "unsupported_content", body: "SECRET" },
    ]) {
      expect(
        getZaloAccountMessageEvidence({ zaloAccount: { unsupported } }),
      ).toEqual({
        schemaVersion: 1,
        unsupported: { reason: "invalid_content" },
      })
    }
  })
})

const route = {
  kind: "account" as const,
  workspaceId: "w",
  accountId: "a",
  inboxId: "i",
}
const transport = {
  version: 1,
  eventId: "event",
  route,
  epoch: 1,
  fenceToken: "1",
  occurredAt: "2026-11-23T00:00:00.000Z",
}

describe("Zalo message and command safety contracts", () => {
  it("validates pagination and avatar protocol without accepting credentials", () => {
    const friend = {
      uid: "123",
      name: "Friend",
      avatarUrl: "https://cdn.test/avatar",
    }
    expect(
      zaloAccountFriendSyncSchema.safeParse({
        friends: [friend],
        complete: true,
      }).success,
    ).toBe(true)
    expect(
      zaloAccountFriendSyncSchema.safeParse({
        friends: [],
        complete: false,
        nextCursor: 2,
      }).success,
    ).toBe(true)
    expect(
      zaloAccountFriendSyncSchema.safeParse({ friends: [], complete: false })
        .success,
    ).toBe(false)
    expect(
      zaloAccountFriendSyncSchema.safeParse({
        friends: [],
        complete: true,
        nextCursor: 2,
      }).success,
    ).toBe(false)
    for (const avatarUrl of [
      "http://cdn.test/avatar",
      "https://user:pass@cdn.test/avatar",
    ]) {
      expect(
        zaloAccountFriendSyncSchema.safeParse({
          friends: [{ ...friend, avatarUrl }],
          complete: true,
        }).success,
      ).toBe(false)
    }
  })
  it("requires group policy context only for group typing commands and events", () => {
    const command = {
      version: 1,
      commandId: "c",
      kind: "send_typing",
      route,
      target: { ownerId: "o", fenceToken: "1" },
      createdAt: transport.occurredAt,
      expiresAt: "2026-11-23T00:01:00.000Z",
      threadType: "user",
      threadId: "p",
    }
    expect(zaloAccountCommandEnvelopeSchema.safeParse(command).success).toBe(
      true,
    )
    expect(
      zaloAccountCommandEnvelopeSchema.safeParse({
        ...command,
        threadType: "group",
      }).success,
    ).toBe(false)
    expect(
      zaloAccountCommandEnvelopeSchema.safeParse({
        ...command,
        threadType: "group",
        accountPolicyEpoch: 1,
        groupPolicyEpoch: 2,
      }).success,
    ).toBe(true)
    const payload = {
      type: "typing",
      threadType: "user",
      threadId: "p",
      actorId: "p",
      seconds: 3,
      timestampMs: 1,
    }
    expect(
      zaloAccountTransportEventSchema.safeParse({
        ...transport,
        kind: "thread_event",
        payload,
      }).success,
    ).toBe(true)
    expect(
      zaloAccountTransportEventSchema.safeParse({
        ...transport,
        kind: "thread_event",
        payload: { ...payload, threadType: "group" },
      }).success,
    ).toBe(false)
    expect(
      zaloAccountTransportEventSchema.safeParse({
        ...transport,
        kind: "thread_event",
        payload: { ...payload, threadType: "group" },
        accountPolicyEpoch: 1,
        groupPolicyEpoch: 2,
      }).success,
    ).toBe(true)
  })
  it("rejects impossible command chronology with a future expiration", () => {
    expect(() =>
      parseZaloAccountCommandEnvelope(
        {
          version: 1,
          commandId: "c",
          kind: "reconnect",
          route,
          createdAt: "2026-11-23T00:02:00.000Z",
          expiresAt: "2026-11-23T00:01:00.000Z",
        },
        { now: new Date(transport.occurredAt) },
      ),
    ).toThrow("expires before")
  })
  it("allows an image caption but rejects a file caption and duplicate label IDs", () => {
    const outbound = {
      recipientId: "p",
      text: "caption",
      attachments: [{ kind: "image", url: "https://cdn.test/a" }],
    }
    expect(zaloAccountOutboundMessageSchema.safeParse(outbound).success).toBe(
      true,
    )
    expect(
      zaloAccountOutboundMessageSchema.safeParse({
        ...outbound,
        attachments: [{ kind: "file", url: "https://cdn.test/a" }],
      }).success,
    ).toBe(false)
    expect(
      zaloAccountOutboundMessageSchema.safeParse({
        recipientId: "p",
        attachments: [],
      }).success,
    ).toBe(false)
    const label = {
      id: 1,
      text: "VIP",
      textKey: "",
      color: "#ffffff",
      offset: 0,
      conversations: [],
      emoji: "",
      createTime: 0,
    }
    expect(
      zaloAccountLabelSnapshotSchema.safeParse({
        labelData: [label, label],
        version: 1,
        lastUpdateTime: 1,
      }).success,
    ).toBe(false)
  })
})

describe("Zalo encrypted event scope", () => {
  it("requires matching complete observation coordinates and a nonempty command identity", () => {
    const scope = {
      route,
      epoch: 1,
      fenceToken: "1",
      eventId: "e",
      socketAttempt: 2,
      sequence: 3,
    }
    const aad = zaloAccountSecretEventAad({ ...scope, commandId: "c" })
    expect(isZaloAccountSecretEventAadValid({ ...scope, aad })).toBe(true)
    expect(
      isZaloAccountSecretEventAadValid({ ...scope, sequence: undefined, aad }),
    ).toBe(false)
    expect(
      isZaloAccountSecretEventAadValid({
        ...scope,
        socketAttempt: undefined,
        aad,
      }),
    ).toBe(false)
    expect(
      isZaloAccountSecretEventAadValid({
        ...scope,
        route: { ...route, accountId: "other" },
        aad,
      }),
    ).toBe(false)
    expect(
      isZaloAccountSecretEventAadValid({ ...scope, sequence: 4, aad }),
    ).toBe(false)
    expect(
      isZaloAccountSecretEventAadValid({
        ...scope,
        aad: zaloAccountSecretEventAad({ ...scope, commandId: "" }),
      }),
    ).toBe(false)
    const sessionScope = {
      ...scope,
      route: {
        kind: "connect_session" as const,
        workspaceId: "w",
        sessionId: "s",
      },
      socketAttempt: undefined,
      sequence: undefined,
    }
    expect(
      isZaloAccountSecretEventAadValid({
        ...sessionScope,
        aad: zaloAccountSecretEventAad({ ...sessionScope, commandId: "c" }),
      }),
    ).toBe(true)
  })
  it("rejects ciphertext bound to a different envelope AAD", () => {
    const event = {
      ...transport,
      kind: "secret",
      secretKind: "authorization_obtained",
      aad: "scope",
      ciphertext: {
        v: 1,
        iv: "0".repeat(24),
        text: "encrypted",
        tag: "0".repeat(32),
        aad: "scope",
      },
    }
    expect(zaloAccountTransportEventSchema.safeParse(event).success).toBe(true)
    expect(
      zaloAccountTransportEventSchema.safeParse({
        ...event,
        ciphertext: { ...event.ciphertext, aad: "other" },
      }).success,
    ).toBe(false)
  })
})

describe("Zalo runtime ordering and transport isolation", () => {
  const previous = {
    epoch: 1,
    fenceToken: "100000000000000000000",
    occurredAt: transport.occurredAt,
    state: "connected" as const,
  }
  it("uses exact fence integer ordering, then epoch, timestamp and terminal state", () => {
    expect(isNewerZaloAccountRuntimeEvent(previous)).toBe(true)
    expect(
      isNewerZaloAccountRuntimeEvent(
        { ...previous, fenceToken: "100000000000000000001" },
        previous,
      ),
    ).toBe(true)
    expect(
      isNewerZaloAccountRuntimeEvent(
        { ...previous, fenceToken: "99999999999999999999" },
        previous,
      ),
    ).toBe(false)
    expect(
      isNewerZaloAccountRuntimeEvent({ ...previous, epoch: 2 }, previous),
    ).toBe(true)
    expect(
      isNewerZaloAccountRuntimeEvent({ ...previous, epoch: 0 }, previous),
    ).toBe(false)
    expect(
      isNewerZaloAccountRuntimeEvent(
        { ...previous, occurredAt: "2026-11-23T00:00:01.000Z" },
        previous,
      ),
    ).toBe(true)
    expect(
      isNewerZaloAccountRuntimeEvent(
        { ...previous, occurredAt: "2026-11-22T23:59:59.000Z" },
        previous,
      ),
    ).toBe(false)
    expect(
      isNewerZaloAccountRuntimeEvent(
        { ...previous, state: "closed" },
        previous,
      ),
    ).toBe(true)
    expect(
      isNewerZaloAccountRuntimeEvent(previous, {
        ...previous,
        state: "reauthorization_required",
      }),
    ).toBe(false)
    const ordered = { ...previous, socketAttempt: 2, sequence: 3 }
    expect(
      isNewerZaloAccountRuntimeEvent(
        { ...ordered, socketAttempt: 3, sequence: 1 },
        ordered,
      ),
    ).toBe(true)
    expect(
      isNewerZaloAccountRuntimeEvent({ ...ordered, sequence: 4 }, ordered),
    ).toBe(true)
    expect(isNewerZaloAccountRuntimeEvent(ordered, ordered)).toBe(false)
  })
  it("encodes untrusted key components and isolates session/account locks", () => {
    expect(zaloAccountTransportKeys.ownerMailbox("o:a")).toBe(
      "zalo-account:commands:owner:o%3Aa",
    )
    expect(zaloAccountTransportKeys.commandResult("c:a")).toBe(
      "zalo-account:command-result:c%3Aa",
    )
    expect(zaloAccountTransportKeys.commandState("w:a")).toBe(
      "zalo-account:command-state:w%3Aa",
    )
    expect(
      zaloAccountTransportKeys.labelVersion({
        workspaceId: "w:a",
        accountId: "a:b",
      }),
    ).toBe("zalo-account:label-version:w%3Aa:a%3Ab")
    const scope = {
      workspaceId: "w:a",
      runtime: { kind: "account" as const, id: "a:b" },
    }
    expect(zaloAccountTransportKeys.lease(scope)).toBe(
      "zalo-account:{w%3Aa:account:a%3Ab}:lease",
    )
    expect(zaloAccountTransportKeys.snapshot(scope)).toBe(
      "zalo-account:{w%3Aa:account:a%3Ab}:snapshot",
    )
    expect(zaloAccountTransportKeys.fence(scope)).toBe(
      "zalo-account:{w%3Aa:account:a%3Ab}:fence",
    )
    expect(
      zaloAccountTransportKeys.lease({
        ...scope,
        runtime: { kind: "connect_session", id: "a:b" },
      }),
    ).not.toBe(zaloAccountTransportKeys.lease(scope))
  })
})

it("allows an empty removed reaction but requires an added reaction key", () => {
  const event = {
    type: "reaction",
    threadId: "p",
    threadType: "user",
    timestampMs: 1,
    providerMessageId: "m",
    actorId: "p",
    reactionKey: "",
    operation: "remove",
  }
  expect(zaloAccountThreadEventSchema.safeParse(event).success).toBe(true)
  expect(
    zaloAccountThreadEventSchema.safeParse({ ...event, operation: "add" })
      .success,
  ).toBe(false)
  expect(
    zaloAccountThreadEventSchema.safeParse({
      ...event,
      operation: "add",
      reactionKey: "heart",
    }).success,
  ).toBe(true)
})

describe("Zalo reconciliation revision projection", () => {
  it.each([
    undefined,
    null,
    "SECRET",
    {},
    { zaloAccount: null },
    { zaloAccount: {} },
    { zaloAccount: { sendAttempt: null } },
    { zaloAccount: { sendAttempt: {} } },
    { zaloAccount: { sendAttempt: { reconciliation: null } } },
  ])("does not invent a revision for legacy or malformed metadata %#", (attributes) => {
    expect(getZaloAccountSendAttemptRevision(attributes)).toBeUndefined()
  })
  it.each([
    0,
    1,
    Number.MAX_SAFE_INTEGER,
  ])("accepts exact nonnegative revision %s", (revision) => {
    expect(
      getZaloAccountSendAttemptRevision({
        zaloAccount: { sendAttempt: { reconciliation: { revision } } },
      }),
    ).toBe(revision)
  })
  it.each([
    -1,
    0.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
    {},
    [],
  ])("rejects unsafe or coerced revision %#", (revision) => {
    expect(
      getZaloAccountSendAttemptRevision({
        zaloAccount: { sendAttempt: { reconciliation: { revision } } },
      }),
    ).toBeUndefined()
  })
})

it("never accepts supported content or automation mentions alongside a placeholder", () => {
  const marker = { reason: "unsupported_content" }
  const quote = {
    providerMessageId: "q",
    senderId: "p",
    timestampMs: 1,
    msgType: "webchat",
  }
  const group = {
    providerMessageId: "m",
    threadId: "g",
    threadType: "group",
    senderId: "p",
    timestampMs: 1,
    msgType: "poll",
    isSelf: false,
    attachments: [],
    mentions: [],
    unsupported: marker,
  }
  expect(zaloAccountGroupMessageSchema.safeParse(group).success).toBe(true)
  const supportedParts = [
    { text: "SECRET" },
    { attachments: [{ kind: "image", url: "https://cdn.test/a" }] },
    { quote },
    { mentions: [{ uid: "p", offset: 0, length: 1 }] },
  ]
  for (const extra of supportedParts) {
    expect(
      zaloAccountGroupMessageSchema.safeParse({ ...group, ...extra }).success,
    ).toBe(false)
  }
  for (const extra of supportedParts.slice(0, 3)) {
    expect(
      zaloAccountDirectMessageSchema.safeParse({
        ...direct,
        unsupported: marker,
        ...extra,
      }).success,
    ).toBe(false)
  }
  expect(
    zaloAccountGroupMessageSchema.safeParse({
      ...group,
      unsupported: undefined,
    }).success,
  ).toBe(false)
  expect(
    zaloAccountGroupMessageSchema.safeParse({
      ...group,
      unsupported: undefined,
      attachments: [{ kind: "image", url: "https://cdn.test/a" }],
      mentions: [{ uid: "p", offset: 0, length: 1 }],
    }).success,
  ).toBe(false)
})
it("uses current time when no command clock override is supplied", () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(transport.occurredAt))
    const command = {
      version: 1,
      commandId: "c",
      kind: "reconnect",
      route,
      createdAt: transport.occurredAt,
      expiresAt: "2026-11-23T00:01:00.000Z",
    }
    expect(parseZaloAccountCommandEnvelope(command)).toEqual(command)
    vi.setSystemTime(new Date("2026-11-23T00:01:00.000Z"))
    expect(() => parseZaloAccountCommandEnvelope(command)).toThrow("expired")
  } finally {
    vi.useRealTimers()
  }
})

it("accepts attachment-only direct messages and rejects a blank text without media", () => {
  expect(
    zaloAccountDirectMessageSchema.safeParse({
      ...direct,
      attachments: [{ kind: "image", url: "https://cdn.test/a" }],
    }).success,
  ).toBe(true)
  expect(
    zaloAccountDirectMessageSchema.safeParse({ ...direct, text: "   " })
      .success,
  ).toBe(false)
  expect(zaloAccountDirectMessageSchema.safeParse(direct).success).toBe(false)
})
