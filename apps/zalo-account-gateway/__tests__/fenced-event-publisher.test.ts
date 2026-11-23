import type {
  ZaloAccountAuthorizationEvent,
  ZaloAccountLifecycleEvent,
} from "@chatbotx.io/sdk"
import { zaloAccountDirectMessageSchema } from "@chatbotx.io/sdk"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { AccountLease, AccountRuntimeScope } from "../src/runtime/ports"
import { FencedEventPublisher } from "../src/transport/fenced-event-publisher"

const appendIfOwned = vi.fn(
  async (
    _scope: AccountRuntimeScope,
    _lease: AccountLease,
    _input: { fields: string[]; maxLen: number; streamKey: string },
  ): Promise<string | null> => "1-0",
)

const publisher = () =>
  new FencedEventPublisher({
    appendPort: { appendIfOwned },
    eventStreamKey: "zalo-account:events",
    maxLen: 1000,
    ownerId: "owner-1",
  })

const context = {
  workspaceId: "workspace-1",
  commandId: "command-1",
}
const STALE_FENCE_PATTERN = /stale fence/i

const payloadOfLastAppend = () => {
  const fields = appendIfOwned.mock.calls.at(-1)?.[2].fields ?? []
  const payloadIndex = fields.indexOf("payload")
  return fields[payloadIndex + 1] ?? "{}"
}

describe("FencedEventPublisher", () => {
  it("preserves observation order outside the strict lifecycle payload", async () => {
    await publisher().publishLifecycle(
      {
        type: "runtime_diagnostic",
        runtime: { kind: "account", id: "account-1" },
        epoch: 1,
        fenceToken: "2",
        socketAttempt: 3,
        sequence: 7,
        occurredAt: "2026-11-23T00:00:00.000Z",
        diagnostics: { phase: "connecting", reconnectCount: 0 },
      },
      { ...context, inboxId: "inbox-1" },
    )
    expect(JSON.parse(payloadOfLastAppend())).toMatchObject({
      socketAttempt: 3,
      sequence: 7,
      occurredAt: "2026-11-23T00:00:00.000Z",
      payload: {
        type: "runtime_diagnostic",
        diagnostics: { phase: "connecting" },
      },
    })
  })
  it("publishes group message content only with a current receive policy", async () => {
    appendIfOwned.mockClear()
    const resolveGroupReceivePolicy = vi
      .fn()
      .mockResolvedValue({ accountPolicyEpoch: 3, groupPolicyEpoch: 4 })
    const sink = new FencedEventPublisher({
      appendPort: { appendIfOwned },
      eventStreamKey: "events",
      maxLen: 1000,
      ownerId: "owner-1",
      resolveGroupReceivePolicy,
    })
    const message = {
      providerMessageId: "m1",
      threadId: "g1",
      threadType: "group" as const,
      senderId: "member",
      timestampMs: 1,
      msgType: "webchat",
      isSelf: false,
      text: "hello",
      mentions: [],
      attachments: [],
    }
    const route = {
      ...context,
      accountId: "account-1",
      inboxId: "inbox-1",
      epoch: 1,
      fenceToken: "2",
    }
    await sink.publishGroupMessage(message, route)
    expect(JSON.parse(payloadOfLastAppend())).toMatchObject({
      kind: "group_message",
      payload: { senderId: "member" },
      accountPolicyEpoch: 3,
      groupPolicyEpoch: 4,
    })
    appendIfOwned.mockClear()
    resolveGroupReceivePolicy.mockResolvedValue(null)
    await sink.publishGroupMessage(message, route)
    expect(appendIfOwned).not.toHaveBeenCalled()
  })
  it("encrypts QR data before appending it to Redis", async () => {
    appendIfOwned.mockClear()
    const event: ZaloAccountLifecycleEvent = {
      type: "qr_generated",
      runtime: { kind: "connect_session", id: "session-1" },
      epoch: 1,
      fenceToken: "2",
      imageDataUrl: "data:image/png;base64,QUJD",
      expiresAt: "2026-11-20T03:00:00.000Z",
    }

    await publisher().publishLifecycle(event, context)

    const serialized = payloadOfLastAppend()
    expect(serialized).toBeTypeOf("string")
    expect(serialized).not.toContain("data:image/png")
    expect(JSON.parse(serialized ?? "{}")).toMatchObject({
      kind: "secret",
      secretKind: "qr_generated",
    })
  })

  it("encrypts authorization and binds it to the event AAD", async () => {
    appendIfOwned.mockClear()
    const event: ZaloAccountAuthorizationEvent = {
      type: "authorization_obtained",
      runtime: { kind: "connect_session", id: "session-1" },
      epoch: 1,
      fenceToken: "2",
      auth: {
        authType: "custom",
        cookie: [{ key: "zpw", value: "secret-cookie" }],
        imei: "secret-imei",
        userAgent: "secret-agent",
        zaloUid: "uid-1",
      },
      displayName: "Jacky",
    }

    await publisher().publishAuthorization(event, context)

    const serialized = payloadOfLastAppend()
    expect(serialized).not.toContain("secret-cookie")
    expect(serialized).not.toContain("secret-imei")
    const envelope = JSON.parse(serialized)
    expect(envelope.ciphertext.aad).toBe(envelope.aad)
  })

  it("fails closed when the fence is no longer current", async () => {
    appendIfOwned.mockResolvedValueOnce(null)
    const event: ZaloAccountLifecycleEvent = {
      type: "qr_scanned",
      runtime: { kind: "connect_session", id: "session-1" },
      epoch: 1,
      fenceToken: "2",
      displayName: "Jacky",
    }

    await expect(publisher().publishLifecycle(event, context)).rejects.toThrow(
      STALE_FENCE_PATTERN,
    )
  })

  it("publishes group activity on its dedicated fenced event kind", async () => {
    appendIfOwned.mockClear()

    await publisher().publishGroupActivity(
      { providerGroupId: "group-1", providerMessageId: "message-1" },
      {
        ...context,
        accountId: "account-1",
        inboxId: "inbox-1",
        epoch: 2,
        fenceToken: "8",
      },
    )

    expect(JSON.parse(payloadOfLastAppend())).toMatchObject({
      kind: "group_activity",
      route: {
        kind: "account",
        accountId: "account-1",
        inboxId: "inbox-1",
      },
      payload: {
        providerGroupId: "group-1",
        providerMessageId: "message-1",
      },
    })
  })
})

it("omits new metadata in the default legacy frame and suppresses placeholders", async () => {
  const message = {
    schemaVersion: 1 as const,
    providerMessageId: "m1",
    threadId: "p",
    threadType: "user" as const,
    senderId: "p",
    recipientId: "s",
    timestampMs: 1,
    msgType: "webchat",
    isSelf: false,
    text: "hello",
    attachments: [],
  }
  await publisher().publishDirectMessage(message, {
    ...context,
    accountId: "a",
    inboxId: "i",
    epoch: 1,
    fenceToken: "1",
  })
  const {
    schemaVersion: _version,
    unsupported: _marker,
    ...legacyShape
  } = zaloAccountDirectMessageSchema.shape
  expect(
    z
      .object(legacyShape)
      .strict()
      .safeParse(JSON.parse(payloadOfLastAppend()).payload).success,
  ).toBe(true)
  expect(JSON.parse(payloadOfLastAppend()).payload).not.toHaveProperty(
    "schemaVersion",
  )
  appendIfOwned.mockClear()
  await publisher().publishDirectMessage(
    { ...message, unsupported: { reason: "unsupported_content" } },
    { ...context, accountId: "a", inboxId: "i", epoch: 1, fenceToken: "1" },
  )
  expect(appendIfOwned).not.toHaveBeenCalled()
})
it("retries a failed append once with the identical transport event identity", async () => {
  appendIfOwned.mockRejectedValueOnce(new Error("redis unavailable"))
  const start = appendIfOwned.mock.calls.length
  await publisher().publishDirectMessage(
    {
      providerMessageId: "m1",
      threadId: "p",
      threadType: "user",
      senderId: "p",
      recipientId: "s",
      timestampMs: 1,
      msgType: "webchat",
      isSelf: false,
      text: "hello",
      attachments: [],
    },
    { ...context, accountId: "a", inboxId: "i", epoch: 1, fenceToken: "1" },
  )
  expect(appendIfOwned.mock.calls.length - start).toBe(2)
  expect(appendIfOwned.mock.calls[start][2].fields).toEqual(
    appendIfOwned.mock.calls[start + 1][2].fields,
  )
})
