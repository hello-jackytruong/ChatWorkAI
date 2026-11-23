import { afterEach, expect, it, vi } from "vitest"
import type { ZcaApiPort } from "../src/runtime/ports"
import { ZaloAccountPool } from "../src/runtime/zalo-account-pool"

afterEach(() => vi.useRealTimers())
const makePool = (
  create: ConstructorParameters<
    typeof ZaloAccountPool
  >[0]["clientFactory"]["create"],
  load = vi.fn(),
) =>
  new ZaloAccountPool({
    clientFactory: { create },
    lease: {
      acquire: async (_scope, ownerId) => ({ ownerId, fenceToken: "1" }),
      renew: async () => true,
      release: async () => true,
    },
    eventSink: {
      publishAuthorization: async () => undefined,
      publishDirectMessage: async () => undefined,
      publishDirectStatus: async () => undefined,
      publishDirectUndo: async () => undefined,
      publishGroupActivity: async () => undefined,
      publishLifecycle: async () => undefined,
    },
    leaseRenewMs: 10_000,
    leaseTtlMs: 30_000,
    ownerId: "test",
    secretPort: { load },
  })
const command = (id: string) => ({
  workspaceId: "w",
  runtime: { kind: "connect_session" as const, id },
})

it("admits at most two login requests and cancels every deferred QR watchdog", async () => {
  vi.useFakeTimers()
  let active = 0
  let peak = 0
  let calls = 0
  const pool = makePool(() => {
    let reject: ((error: Error) => void) | undefined
    return {
      login: vi.fn(),
      loginQr: () => {
        calls += 1
        active += 1
        peak = Math.max(peak, active)
        return new Promise<ZcaApiPort>((_resolve, rejectLogin) => {
          reject = rejectLogin
        }).finally(() => {
          active -= 1
        })
      },
      cancel: () => {
        reject?.(new Error("cancelled"))
        return Promise.resolve()
      },
    }
  })
  await pool.startQr(command("a"))
  await pool.startQr(command("b"))
  await pool.startQr(command("c"))
  expect(calls).toBe(2)
  await pool.stop(command("a"))
  await vi.advanceTimersByTimeAsync(1000)
  expect(calls).toBe(3)
  expect(peak).toBe(2)
  await pool.shutdown()
  expect(active).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("evicts settled terminal sessions instead of retaining their runtime keys", async () => {
  const pool = makePool(() => ({
    login: vi.fn(),
    loginQr: () => Promise.reject(new Error("terminal fixture")),
    cancel: () => Promise.resolve(),
  }))
  for (let index = 0; index < 30; index += 1) {
    await pool.startQr(command(String(index)))
  }
  const maps = pool as unknown as {
    runtimes: Map<string, unknown>
    epochs: Map<string, unknown>
    cancellationEpochs: Map<string, unknown>
    operations: Map<string, unknown>
  }
  await vi.waitFor(() => expect(maps.runtimes.size).toBe(0))
  expect(maps.epochs.size).toBe(0)
  expect(maps.cancellationEpochs.size).toBe(0)
  expect(maps.operations.size).toBe(0)
  await pool.shutdown()
})

it("retains an unconfirmed-close tombstone and permits retry only after cleanup confirms", async () => {
  const closeConnection = vi
    .fn()
    .mockRejectedValueOnce(new Error("unconfirmed"))
    .mockResolvedValue(undefined)
  const login = vi.fn(
    async () =>
      ({
        closeConnection,
        getOwnId: async () => "uid",
        listen: () => ({ start: vi.fn(), stop: vi.fn() }),
      }) as unknown as ZcaApiPort,
  )
  const load = vi.fn(async () => ({
    auth: {
      authType: "custom",
      cookie: [{ key: "test", value: "test" }],
      imei: "test",
      userAgent: "test",
      zaloUid: "uid",
    },
    zaloUid: "uid",
  }))
  const pool = makePool(
    () => ({ login, loginQr: vi.fn(), cancel: async () => undefined }),
    load,
  )
  const account = {
    workspaceId: "w",
    inboxId: "i",
    runtime: { kind: "account" as const, id: "a" },
  }
  await pool.reconnect(account)
  await expect(pool.stop(account)).rejects.toThrow("unconfirmed")
  await expect(pool.reconnect(account)).rejects.toThrow(
    "cleanup is unconfirmed",
  )
  expect(login).toHaveBeenCalledOnce()
  await pool.stop(account)
  await pool.reconnect(account)
  expect(login).toHaveBeenCalledTimes(2)
  await pool.shutdown()
})
