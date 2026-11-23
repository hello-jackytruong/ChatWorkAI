import type { ZaloAccountCommandEnvelope } from "@chatbotx.io/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ZaloAccountCommandTransport } from "../src/zalo-account/transport.service"

const redis = {
  eval: vi.fn(async () => 1),
  get: vi.fn(),
}

const transport = new ZaloAccountCommandTransport(redis as never)

describe("ZaloAccountCommandTransport", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    redis.eval.mockResolvedValue(1)
    redis.get.mockResolvedValue(null)
  })

  it("preserves the friend page cursor in the dispatched command", async () => {
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: {
          status: "synced",
          friendSync: { friends: [], complete: true },
        },
      }),
    )
    await transport.syncFriendsAndWait({
      commandId: "friends-1",
      workspaceId: "w",
      accountId: "a",
      inboxId: "i",
      cursor: 2,
      ttlMs: 30_000,
      waitTimeoutMs: 100,
    })
    expect(JSON.parse(String(redis.eval.mock.calls[0]?.at(-1)))).toMatchObject({
      kind: "sync_friends",
      cursor: 2,
    })
  })

  it("dispatches group typing without leaking the caller's local group ID", async () => {
    redis.get.mockResolvedValueOnce("owner-1:9")
    const input = {
      commandId: "typing-1",
      workspaceId: "w",
      accountId: "a",
      inboxId: "i",
      groupId: "local-group",
      providerGroupId: "provider-group",
      threadId: "provider-group",
      threadType: "group" as const,
      accountPolicyEpoch: 1,
      groupPolicyEpoch: 2,
      ttlMs: 5000,
    }
    await transport.sendTyping(input)
    const command = JSON.parse(String(redis.eval.mock.calls.at(-1)?.at(-1)))
    expect(command).toMatchObject({
      kind: "send_typing",
      threadId: "provider-group",
      accountPolicyEpoch: 1,
      groupPolicyEpoch: 2,
    })
    expect(command).not.toHaveProperty("groupId")
  })

  it("publishes QR startup to the shared acquisition stream", async () => {
    const command = await transport.startQr({
      commandId: "command-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      ttlMs: 30_000,
    })

    expect(command).toMatchObject({
      kind: "start_qr",
      route: {
        kind: "connect_session",
        workspaceId: "workspace-1",
        sessionId: "session-1",
      },
    })
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("XLEN"),
      1,
      "zalo-account:commands:acquire",
      10_000,
      0,
      JSON.stringify(command),
    )
  })

  it("routes a stop command to the current fenced owner mailbox", async () => {
    redis.get.mockResolvedValue("owner-1:9")

    const command = await transport.stop({
      commandId: "command-stop",
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
      ttlMs: 30_000,
    })

    expect((command as ZaloAccountCommandEnvelope).target).toEqual({
      ownerId: "owner-1",
      fenceToken: "9",
    })
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("XLEN"),
      1,
      "zalo-account:commands:owner:owner-1",
      10_000,
      86_400_000,
      JSON.stringify(command),
    )
  })

  it("does not enqueue stop when no runtime owns the account", async () => {
    await expect(
      transport.stop({
        commandId: "command-stop",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        ttlMs: 30_000,
      }),
    ).resolves.toBeNull()
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it("stops a temporary QR runtime through its fenced owner mailbox", async () => {
    redis.get
      .mockResolvedValueOnce("owner-1:4")
      .mockResolvedValueOnce(
        JSON.stringify({ status: "applied", result: { status: "stopped" } }),
      )

    await transport.stopSessionAndWait({
      commandId: "cancel:session-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      ttlMs: 30_000,
      waitTimeoutMs: 100,
    })

    const serialized = redis.eval.mock.calls[0]?.at(-1)
    expect(JSON.parse(String(serialized))).toMatchObject({
      kind: "stop",
      route: {
        kind: "connect_session",
        workspaceId: "workspace-1",
        sessionId: "session-1",
      },
      target: { ownerId: "owner-1", fenceToken: "4" },
    })
  })

  it("waits for the fenced owner to confirm stop before returning", async () => {
    redis.get
      .mockResolvedValueOnce("owner-1:9")
      .mockResolvedValueOnce(
        JSON.stringify({ status: "applied", result: { status: "stopped" } }),
      )

    await expect(
      transport.stopAndWait({
        commandId: "command-stop-confirmed",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        ttlMs: 30_000,
        waitTimeoutMs: 100,
      }),
    ).resolves.toMatchObject({ status: "applied" })

    expect(redis.get).toHaveBeenLastCalledWith(
      "zalo-account:command-result:command-stop-confirmed",
    )
  })

  it("sends once through the current fenced owner and returns provider IDs", async () => {
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: {
          status: "sent",
          messageIds: ["provider-1"],
          sentCount: 1,
        },
      }),
    )

    await expect(
      transport.sendDirectAndWait({
        commandId: "client-1",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        ttlMs: 30_000,
        waitTimeoutMs: 100,
        message: { recipientId: "peer-1", text: "hello", attachments: [] },
      }),
    ).resolves.toEqual({ messageIds: ["provider-1"], sentCount: 1 })

    const serialized = redis.eval.mock.calls[0]?.at(-1)
    expect(JSON.parse(String(serialized))).toMatchObject({
      kind: "send_direct",
      commandId: "client-1",
      target: { ownerId: "owner-1", fenceToken: "9" },
      message: { recipientId: "peer-1", text: "hello" },
    })
  })

  it("keeps an ambiguous send terminal unknown instead of dispatching again", async () => {
    redis.get
      .mockResolvedValueOnce("owner-1:9")
      .mockResolvedValueOnce(JSON.stringify({ status: "unknown" }))

    await expect(
      transport.sendDirectAndWait({
        commandId: "client-unknown",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        ttlMs: 30_000,
        waitTimeoutMs: 100,
        message: { recipientId: "peer-1", text: "hello", attachments: [] },
      }),
    ).rejects.toThrow("outcome is unknown; do not retry automatically")

    expect(redis.eval).toHaveBeenCalledTimes(1)
  })

  it("rejects a label snapshot whose version regresses below the accepted account version", async () => {
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: {
          status: "synced",
          labels: { labelData: [], version: 3, lastUpdateTime: 10 },
        },
      }),
    )
    redis.eval.mockResolvedValueOnce("1-0").mockResolvedValueOnce(0)

    await expect(
      transport.getLabelsAndWait({
        commandId: "labels-1",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        ttlMs: 30_000,
        waitTimeoutMs: 100,
      }),
    ).rejects.toThrow("snapshot version regressed")
  })
})

it("preserves structured admission failure without exposing a provider message", async () => {
  redis.get.mockReset()
  redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
    JSON.stringify({
      status: "failed",
      error: "https://secret.test/raw-body",
      errorInfo: {
        code: "rate_limited",
        phase: "admission",
        retryAfterMs: 1234,
        safeAction: "new_attempt",
      },
    }),
  )
  const sending = transport.sendDirectAndWait({
    commandId: "typed-failure",
    workspaceId: "w",
    accountId: "a",
    inboxId: "i",
    message: { recipientId: "p", text: "hello", attachments: [] },
    ttlMs: 30_000,
    waitTimeoutMs: 100,
  })
  await expect(sending).rejects.toMatchObject({
    errorInfo: { code: "rate_limited", retryAfterMs: 1234 },
  })
  await expect(sending).rejects.not.toThrow("https://secret.test")
})
