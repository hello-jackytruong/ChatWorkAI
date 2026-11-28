import { encryptUtils } from "@chatbotx.io/encryption"
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

  const nativeInput = {
    commandId: "native-tool-1",
    workspaceId: "w",
    accountId: "a",
    inboxId: "i",
    accountPolicyEpoch: 2,
    operation: { kind: "readOwnQr" as const },
    ttlMs: 5000,
    waitTimeoutMs: 100,
  }
  const sensitiveResult = {
    kind: "readOwnQr",
    outcome: "confirmed",
    profileQr: { imageUrl: "https://qr.zalo.me/test-result?token=fixture" },
  }

  it("decrypts a native result only under the exact command and account scope", async () => {
    const aad = JSON.stringify([
      "zalo-native-tool-result-v1",
      "w",
      "a",
      "i",
      "native-tool-1",
      "readOwnQr",
    ])
    const nativeToolCiphertext = await encryptUtils.encryptObject(
      sensitiveResult,
      aad,
    )
    const serialized = JSON.stringify({
      status: "applied",
      result: { status: "synced", nativeToolCiphertext },
    })
    redis.get
      .mockResolvedValueOnce("owner-1:9")
      .mockResolvedValueOnce(serialized)
    await expect(transport.nativeToolAndWait(nativeInput)).resolves.toEqual(
      sensitiveResult,
    )
    redis.get
      .mockResolvedValueOnce("owner-1:9")
      .mockResolvedValueOnce(serialized)
    await expect(
      transport.nativeToolAndWait({
        ...nativeInput,
        accountId: "other-native-account",
      }),
    ).rejects.toThrow()
  })

  it("refuses plaintext or a different native operation result", async () => {
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: { status: "synced", nativeTool: sensitiveResult },
      }),
    )
    await expect(transport.nativeToolAndWait(nativeInput)).rejects.toThrow()
    const aad = JSON.stringify([
      "zalo-native-tool-result-v1",
      "w",
      "a",
      "i",
      "native-tool-1",
      "readOwnQr",
    ])
    const nativeToolCiphertext = await encryptUtils.encryptObject(
      {
        kind: "readOwnBusiness",
        outcome: "confirmed",
        ownBusiness: { packageId: 2 },
      },
      aad,
    )
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: { status: "synced", nativeToolCiphertext },
      }),
    )
    await expect(transport.nativeToolAndWait(nativeInput)).rejects.toThrow()
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

  it("sends bounded group administration reads to the current owner's fenced mailbox", async () => {
    const groupAdministration = {
      kind: "members",
      members: [],
      complete: false,
      visibility: "restricted",
    }
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: { status: "synced", groupAdministration },
      }),
    )
    const groupRead = { kind: "members", cursor: "next", limit: 25 } as const
    await expect(
      transport.readGroupAdministrationAndWait({
        commandId: "group-read-1",
        workspaceId: "w",
        accountId: "a",
        inboxId: "i",
        groupId: "provider-group",
        groupPolicyEpoch: 2,
        accountPolicyEpoch: 1,
        groupRead,
        ttlMs: 5000,
        waitTimeoutMs: 100,
      }),
    ).resolves.toEqual(groupAdministration)
    expect(JSON.parse(String(redis.eval.mock.calls[0]?.at(-1)))).toMatchObject({
      kind: "read_group_administration",
      target: { ownerId: "owner-1", fenceToken: "9" },
      groupRead,
      groupId: "provider-group",
      groupPolicyEpoch: 2,
      accountPolicyEpoch: 1,
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

  it("projects a partial direct acknowledgement and a group acceptance without inventing IDs", async () => {
    const base = {
      commandId: "rich-send",
      workspaceId: "workspace-1",
      accountId: "account-1",
      inboxId: "inbox-1",
      ttlMs: 30_000,
      waitTimeoutMs: 100,
      message: { recipientId: "peer-1", text: "hello", attachments: [] },
    }
    const partial = {
      messageIds: ["original"],
      sentCount: 1,
      delivery: "partial",
      remainingUnknown: true,
    }
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: { status: "sent", ...partial },
      }),
    )
    await expect(transport.sendDirectAndWait(base)).resolves.toEqual(partial)
    const accepted = {
      messageIds: [],
      sentCount: 1,
      delivery: "accepted_without_id",
    }
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: { status: "sent", ...accepted },
      }),
    )
    await expect(
      transport.sendGroupAndWait({
        ...base,
        groupId: "group-1",
        accountPolicyEpoch: 2,
        groupPolicyEpoch: 3,
      }),
    ).resolves.toEqual(accepted)
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

  it("queries one bounded sticker catalog through the exact account mailbox", async () => {
    const sticker = {
      stickerId: "892",
      categoryId: "0",
      stickerType: 7,
      frameCount: 4,
      frameDurationMs: 125,
      staticUrl:
        "https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=892&size=130&version=3",
    }
    redis.get.mockResolvedValueOnce("owner-1:9").mockResolvedValueOnce(
      JSON.stringify({
        status: "applied",
        result: { status: "synced", stickerCatalog: [sticker] },
      }),
    )
    const stickerCatalogQuery = {
      kind: "search" as const,
      query: "hello",
      limit: 20,
    }
    await expect(
      transport.getStickerCatalogAndWait({
        commandId: "sticker-query-1",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
        ttlMs: 10_000,
        waitTimeoutMs: 100,
        stickerCatalogQuery,
      }),
    ).resolves.toEqual([sticker])
    const serialized = redis.eval.mock.calls[0]?.at(-1)
    expect(JSON.parse(String(serialized))).toMatchObject({
      kind: "get_sticker_catalog",
      target: { ownerId: "owner-1", fenceToken: "9" },
      route: {
        kind: "account",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
      },
      stickerCatalogQuery,
    })
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
