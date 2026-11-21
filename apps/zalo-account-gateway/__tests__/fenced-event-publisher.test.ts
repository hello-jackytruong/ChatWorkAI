import type {
  ZaloAccountAuthorizationEvent,
  ZaloAccountLifecycleEvent,
} from "@chatbotx.io/sdk"
import { describe, expect, it, vi } from "vitest"
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
