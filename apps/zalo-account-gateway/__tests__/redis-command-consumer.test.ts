import { zaloAccountTransportKeys } from "@chatbotx.io/sdk"
import { describe, expect, it, vi } from "vitest"
import { RedisCommandConsumer } from "../src/transport/redis-command-consumer"

describe("RedisCommandConsumer", () => {
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
