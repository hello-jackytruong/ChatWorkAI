import { describe, expect, it } from "vitest"
import {
  InMemoryLeaseScriptClient,
  RedisAccountLeaseStore,
} from "../src/runtime/account-lease-store"

const runtime = { kind: "account" as const, id: "account-1" }
const scope = { workspaceId: "workspace-1", runtime }

describe("RedisAccountLeaseStore", () => {
  it("fences sampled diagnostics writes and bounds their payload size", async () => {
    const redis = new InMemoryLeaseScriptClient()
    const store = new RedisAccountLeaseStore(redis)
    const first = await store.acquire(scope, "owner-a", 30_000)
    if (!first) {
      throw new Error("missing first owner")
    }
    await expect(store.writeSnapshot(scope, first, "{}", 60_000)).resolves.toBe(
      true,
    )
    redis.advanceBy(30_001)
    const second = await store.acquire(scope, "owner-b", 30_000)
    if (!second) {
      throw new Error("missing second owner")
    }
    await expect(
      store.writeSnapshot(scope, second, "{}", 60_000),
    ).resolves.toBe(true)
    await expect(store.writeSnapshot(scope, first, "{}", 60_000)).resolves.toBe(
      false,
    )
    await expect(
      store.writeSnapshot(scope, second, "x".repeat(2049), 60_000),
    ).rejects.toThrow()
  })
  it("allows one owner and fences stale renew/release after takeover", async () => {
    const redis = new InMemoryLeaseScriptClient()
    const first = new RedisAccountLeaseStore(redis)
    const second = new RedisAccountLeaseStore(redis)

    const leaseA = await first.acquire(scope, "owner-a", 30_000)
    expect(leaseA).toEqual({ ownerId: "owner-a", fenceToken: "1" })
    if (!leaseA) {
      throw new Error("Expected the first replica to acquire the lease")
    }
    await expect(second.acquire(scope, "owner-b", 30_000)).resolves.toBeNull()
    await expect(first.renew(scope, leaseA, 30_000)).resolves.toBe(true)

    redis.advanceBy(30_001)
    const leaseB = await second.acquire(scope, "owner-b", 30_000)
    if (!leaseB) {
      throw new Error(
        "Expected the second replica to acquire the expired lease",
      )
    }
    expect(BigInt(leaseB.fenceToken)).toBeGreaterThan(BigInt(leaseA.fenceToken))
    await expect(first.renew(scope, leaseA, 30_000)).resolves.toBe(false)
    await expect(first.release(scope, leaseA)).resolves.toBe(false)
    await expect(second.release(scope, leaseB)).resolves.toBe(true)
  })

  it("keeps identical runtime ids isolated by workspace", async () => {
    const redis = new InMemoryLeaseScriptClient()
    const store = new RedisAccountLeaseStore(redis)

    const first = await store.acquire(scope, "owner-a", 30_000)
    const second = await store.acquire(
      { workspaceId: "workspace-2", runtime },
      "owner-b",
      30_000,
    )

    expect(first?.fenceToken).toBe("1")
    expect(second?.fenceToken).toBe("1")
  })

  it("atomically rejects an event append from a stale fence", async () => {
    const redis = new InMemoryLeaseScriptClient()
    const store = new RedisAccountLeaseStore(redis)
    const leaseA = await store.acquire(scope, "owner-a", 30_000)
    if (!leaseA) {
      throw new Error("Expected owner A to acquire the lease")
    }

    await expect(
      store.appendIfOwned(scope, leaseA, {
        streamKey: "zalo-account:events",
        maxLen: 100,
        fields: ["event", "first"],
      }),
    ).resolves.toBe("1-0")

    redis.advanceBy(30_001)
    const leaseB = await store.acquire(scope, "owner-b", 30_000)
    if (!leaseB) {
      throw new Error("Expected owner B to acquire the expired lease")
    }

    await expect(
      store.appendIfOwned(scope, leaseA, {
        streamKey: "zalo-account:events",
        maxLen: 100,
        fields: ["event", "stale"],
      }),
    ).resolves.toBeNull()
    await expect(
      store.appendIfOwned(scope, leaseB, {
        streamKey: "zalo-account:events",
        maxLen: 100,
        fields: ["event", "current"],
      }),
    ).resolves.toBe("2-0")
  })
})
