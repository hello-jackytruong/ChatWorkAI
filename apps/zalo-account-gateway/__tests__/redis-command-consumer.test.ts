import { encryptUtils } from "@chatbotx.io/encryption"
import {
  type ZaloAccountNativeToolResult,
  zaloAccountNativeToolResultSchema,
  zaloAccountTransportKeys,
} from "@chatbotx.io/sdk"
import { describe, expect, it, vi } from "vitest"
import {
  commandStateKey,
  ZaloAccountCommandExecutor,
} from "../src/transport/command-executor"
import { RedisCommandConsumer } from "../src/transport/redis-command-consumer"
import { RedisCommandStateStore } from "../src/transport/redis-command-state-store"

const qr = {
  kind: "readOwnQr",
  outcome: "confirmed",
  profileQr: { imageUrl: "https://qr.zalo.me/test-result?token=fixture" },
} satisfies ZaloAccountNativeToolResult

const createStartupConsumer = () => {
  const connected = Promise.withResolvers<void>()
  const read = Promise.withResolvers<void>()
  const blocking = {
    status: "wait",
    connect: vi.fn(async () => {
      await connected.promise
      blocking.status = "ready"
    }),
    disconnect: vi.fn(() => {
      blocking.status = "end"
      read.resolve()
    }),
    call: vi.fn(async () => {
      if (blocking.status !== "ready") {
        throw new Error(
          "Stream isn't writeable and enableOfflineQueue options is false",
        )
      }
      await read.promise
      throw new Error("Connection is closed")
    }),
  }
  const redis = {
    duplicate: vi.fn(() => blocking),
    xgroup: vi.fn(async () => "OK"),
    call: vi.fn((operation: string) => {
      if (operation === "XAUTOCLAIM") {
        return ["0-0", [], []]
      }
      if (operation === "XINFO") {
        return [["name", zaloAccountTransportKeys.consumerGroup, "lag", 0]]
      }
      throw new Error(`Unexpected Redis call: ${operation}`)
    }),
  }
  const consumer = new RedisCommandConsumer({
    executor: { execute: vi.fn() },
    logger: { warn: vi.fn() },
    ownerId: "owner-1",
    redis: redis as never,
  })
  return { blocking, connected, consumer, redis }
}

describe("RedisCommandConsumer", () => {
  it("encrypts the native tool result before publishing it to Redis", async () => {
    const command = {
      version: 1,
      commandId: "native-result",
      kind: "native_tool",
      route: {
        kind: "account",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
      },
      target: { ownerId: "owner-1", fenceToken: "1" },
      createdAt: "2026-11-20T02:00:00.000Z",
      expiresAt: "2099-11-20T02:01:00.000Z",
      accountPolicyEpoch: 0,
      nativeTool: { kind: "readOwnQr" },
    } as const
    const call = vi.fn((operation: string, stream: string) => {
      if (operation === "XAUTOCLAIM") {
        const entries =
          stream === zaloAccountTransportKeys.ownerMailbox("owner-1")
            ? [["10-0", ["command", JSON.stringify(command)]]]
            : []
        return ["0-0", entries, []]
      }
      if (operation === "XPENDING") {
        return [["10-0", "owner-old", 31_000, 1]]
      }
      throw new Error(`Unexpected Redis call: ${operation}`)
    })
    const stored = new Map<string, string>()
    const set = vi.fn(
      (
        key: string,
        value: string,
        _mode: string,
        _ttl: number,
        condition?: string,
      ) => {
        if (condition === "NX" && stored.has(key)) {
          return Promise.resolve(null)
        }
        stored.set(key, value)
        return Promise.resolve("OK")
      },
    )
    const get = vi.fn(async (key: string) => stored.get(key) ?? null)
    const redis = {
      call,
      set,
      get,
      xack: vi.fn(async () => 1),
      xdel: vi.fn(async () => 1),
    }
    const nativeTool = vi.fn(async () => qr)
    const executor = new ZaloAccountCommandExecutor({
      ownerId: "owner-1",
      stateStore: new RedisCommandStateStore(redis as never),
      pool: { nativeTool } as never,
      ownsTarget: vi.fn(async () => true),
      nativeAccountTool: {
        admit: vi.fn(async () => undefined),
        claimDispatch: vi.fn(async () => true),
        settle: vi.fn(async () => undefined),
      },
    })
    const consumer = new RedisCommandConsumer({
      executor,
      logger: { warn: vi.fn() },
      ownerId: "owner-1",
      redis: redis as never,
    })
    await consumer.reclaimPending()
    const resultKey = zaloAccountTransportKeys.commandResult(command.commandId)
    const stateKey = zaloAccountTransportKeys.commandState(
      commandStateKey(command),
    )
    expect(stored.get(resultKey)).not.toContain("token=fixture")
    expect(stored.get(stateKey)).not.toContain("token=fixture")
    const parsed = JSON.parse(stored.get(resultKey) ?? "{}")
    const state = JSON.parse(stored.get(stateKey) ?? "{}")
    expect(parsed.result).not.toHaveProperty("nativeTool")
    expect(parsed.result).toHaveProperty("nativeToolCiphertext")
    expect(state.outcome.result).toEqual(parsed.result)
    const aad = JSON.stringify([
      "zalo-native-tool-result-v1",
      "workspace-1",
      "account-1",
      "inbox-1",
      "native-result",
      "readOwnQr",
    ])
    await expect(
      encryptUtils.decryptObject(
        parsed.result.nativeToolCiphertext,
        zaloAccountNativeToolResultSchema,
        aad,
      ),
    ).resolves.toEqual(qr)
    expect(redis.xack).toHaveBeenCalledOnce()
    stored.set(
      stateKey,
      JSON.stringify({
        status: "applied",
        outcome: {
          status: "applied",
          result: { status: "synced", nativeTool: qr },
        },
      }),
    )
    await consumer.reclaimPending()
    expect(stored.get(resultKey)).toBe(JSON.stringify({ status: "unknown" }))
    expect(nativeTool).toHaveBeenCalledOnce()
  })

  it("connects the lazy blocking client before reading or reporting ready", async () => {
    const { blocking, connected, consumer, redis } = createStartupConsumer()
    const started = consumer.start()
    const settled = started.catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(redis.duplicate).toHaveBeenCalledOnce())
      expect(blocking.call).not.toHaveBeenCalled()
      expect(consumer.isReady()).toBe(false)
      expect(blocking.connect).toHaveBeenCalledOnce()

      connected.resolve()
      await vi.waitFor(() => expect(blocking.call).toHaveBeenCalledOnce())
      expect(redis.duplicate).toHaveBeenCalledWith({ lazyConnect: true })
      expect(consumer.isReady()).toBe(true)
      consumer.stop()
      await expect(started).resolves.toBeUndefined()
      expect(consumer.isReady()).toBe(false)
    } finally {
      consumer.stop()
      connected.resolve()
      await settled
    }
  })

  it("cleans up the blocking connection when its initial connect fails", async () => {
    const { blocking, consumer } = createStartupConsumer()
    blocking.connect.mockRejectedValueOnce(new Error("fixture connect failed"))

    await expect(consumer.start()).rejects.toThrow("fixture connect failed")

    expect(blocking.call).not.toHaveBeenCalled()
    expect(blocking.disconnect).toHaveBeenCalledOnce()
    expect(consumer.isRunning()).toBe(false)
    expect(consumer.isReady()).toBe(false)
  })

  it("does not start a blocking read after stop during connection setup", async () => {
    const { blocking, connected, consumer, redis } = createStartupConsumer()
    const started = consumer.start()
    const settled = started.catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(redis.duplicate).toHaveBeenCalledOnce())
      consumer.stop()
      connected.resolve()
      await expect(started).resolves.toBeUndefined()
      expect(blocking.call).not.toHaveBeenCalled()
      expect(consumer.isRunning()).toBe(false)
      expect(consumer.isReady()).toBe(false)
    } finally {
      consumer.stop()
      connected.resolve()
      await settled
    }
  })

  it("reclaims an idle pending command and acknowledges it after deduped execution", async () => {
    const command = {
      version: 1,
      commandId: "command-reclaimed",
      kind: "reconnect",
      route: {
        kind: "account",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
      },
      createdAt: "2026-11-20T02:00:00.000Z",
      expiresAt: "2099-11-20T02:01:00.000Z",
    }
    const call = vi.fn((operation: string, stream: string) => {
      if (operation === "XAUTOCLAIM") {
        if (stream !== zaloAccountTransportKeys.acquisitionStream) {
          return ["0-0", [], []]
        }
        return ["0-0", [["10-0", ["command", JSON.stringify(command)]]], []]
      }
      if (operation === "XPENDING") {
        return [["10-0", "owner-old", 31_000, 1]]
      }
      throw new Error(`Unexpected Redis call: ${operation}`)
    })
    const redis = {
      call,
      duplicate: vi.fn(),
      set: vi.fn(async () => "OK"),
      xadd: vi.fn(async () => "20-0"),
      xack: vi.fn(async () => 1),
      xdel: vi.fn(async () => 1),
      xgroup: vi.fn(),
    }
    const executor = {
      execute: vi.fn(async () => ({
        status: "applied" as const,
        result: { status: "coalesced" },
      })),
    }
    const consumer = new RedisCommandConsumer({
      executor,
      logger: { warn: vi.fn() },
      ownerId: "owner-1",
      redis: redis as never,
    })

    await consumer.reclaimPending()

    expect(call).toHaveBeenCalledWith(
      "XAUTOCLAIM",
      zaloAccountTransportKeys.acquisitionStream,
      zaloAccountTransportKeys.consumerGroup,
      "owner-1",
      expect.any(Number),
      "0-0",
      "COUNT",
      20,
    )
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(redis.xack).toHaveBeenCalledWith(
      zaloAccountTransportKeys.acquisitionStream,
      zaloAccountTransportKeys.consumerGroup,
      "10-0",
    )
    expect(redis.xdel).toHaveBeenCalledWith(
      zaloAccountTransportKeys.acquisitionStream,
      "10-0",
    )
  })

  it("moves malformed commands to a bounded redacted dead-letter stream", async () => {
    const call = vi.fn((operation: string, stream: string) => {
      if (operation === "XAUTOCLAIM") {
        return stream === zaloAccountTransportKeys.acquisitionStream
          ? ["0-0", [["11-0", ["command", "{secret-cookie"]]], []]
          : ["0-0", [], []]
      }
      if (operation === "XPENDING") {
        return [["11-0", "owner-old", 31_000, 1]]
      }
      throw new Error(`Unexpected Redis call: ${operation}`)
    })
    const redis = {
      call,
      duplicate: vi.fn(),
      set: vi.fn(async () => "OK"),
      xadd: vi.fn(async () => "21-0"),
      xack: vi.fn(async () => 1),
      xdel: vi.fn(async () => 1),
      xgroup: vi.fn(),
    }
    const executor = { execute: vi.fn() }
    const consumer = new RedisCommandConsumer({
      executor,
      logger: { warn: vi.fn() },
      ownerId: "owner-1",
      redis: redis as never,
    })

    await consumer.reclaimPending()

    expect(executor.execute).not.toHaveBeenCalled()
    expect(redis.xadd).toHaveBeenCalledWith(
      zaloAccountTransportKeys.commandDeadLetterStream,
      "MAXLEN",
      "~",
      10_000,
      "*",
      "sourceStream",
      zaloAccountTransportKeys.acquisitionStream,
      "originalId",
      "11-0",
      "deliveryCount",
      "1",
      "error",
      expect.any(String),
      "timestamp",
      expect.any(String),
    )
    expect(JSON.stringify(redis.xadd.mock.calls)).not.toContain("secret-cookie")
  })

  it("leaves infrastructure failures pending so another owner can reclaim them", async () => {
    const command = {
      version: 1,
      commandId: "command-retry",
      kind: "reconnect",
      route: {
        kind: "account",
        workspaceId: "workspace-1",
        accountId: "account-1",
        inboxId: "inbox-1",
      },
      createdAt: "2026-11-20T02:00:00.000Z",
      expiresAt: "2099-11-20T02:01:00.000Z",
    }
    const call = vi.fn((operation: string, stream: string) => {
      if (operation === "XAUTOCLAIM") {
        return stream === zaloAccountTransportKeys.acquisitionStream
          ? ["0-0", [["12-0", ["command", JSON.stringify(command)]]], []]
          : ["0-0", [], []]
      }
      if (operation === "XPENDING") {
        return [["12-0", "owner-old", 31_000, 1]]
      }
      throw new Error(`Unexpected Redis call: ${operation}`)
    })
    const redis = {
      call,
      duplicate: vi.fn(),
      set: vi.fn(async () => "OK"),
      xadd: vi.fn(async () => "22-0"),
      xack: vi.fn(async () => 1),
      xdel: vi.fn(async () => 1),
      xgroup: vi.fn(),
    }
    const consumer = new RedisCommandConsumer({
      executor: {
        execute: vi.fn(async () =>
          Promise.reject(new Error("Redis result write failed")),
        ),
      },
      logger: { warn: vi.fn() },
      ownerId: "owner-1",
      redis: redis as never,
    })

    await consumer.reclaimPending()

    expect(redis.xack).not.toHaveBeenCalled()
    expect(redis.xdel).not.toHaveBeenCalled()
    expect(redis.xadd).not.toHaveBeenCalled()
  })
})
