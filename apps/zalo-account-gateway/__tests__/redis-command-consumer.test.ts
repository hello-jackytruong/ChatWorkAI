import { zaloAccountTransportKeys } from "@chatbotx.io/sdk"
import { describe, expect, it, vi } from "vitest"
import { RedisCommandConsumer } from "../src/transport/redis-command-consumer"

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
