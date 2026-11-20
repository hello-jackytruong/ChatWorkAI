import type { ZaloAccountAuth } from "@chatbotx.io/sdk"
import { describe, expect, it, vi } from "vitest"
import type {
  AccountLease,
  AccountLeasePort,
  ZcaApiPort,
} from "../src/runtime/ports"
import { ZaloAccountPool } from "../src/runtime/zalo-account-pool"

const auth: ZaloAccountAuth = {
  authType: "custom",
  cookie: [{ key: "a", value: "b" }],
  imei: "imei",
  userAgent: "agent",
  zaloUid: "uid-1",
}

describe("ZaloAccountPool", () => {
  it("coalesces local starts and returns owned_elsewhere to a racing replica", async () => {
    let owner: string | null = null
    let fence = 0
    const lease: AccountLeasePort = {
      acquire: vi.fn((_runtime, ownerId) => {
        if (owner) {
          return Promise.resolve(null)
        }
        owner = ownerId
        fence += 1
        return Promise.resolve({ ownerId, fenceToken: String(fence) })
      }),
      renew: vi.fn((_runtime, candidate) =>
        Promise.resolve(candidate.ownerId === owner),
      ),
      release: vi.fn((_runtime, candidate) => {
        if (candidate.ownerId !== owner) {
          return Promise.resolve(false)
        }
        owner = null
        return Promise.resolve(true)
      }),
    }
    const makePool = (ownerId: string) =>
      new ZaloAccountPool({
        clientFactory: {
          create: () => ({
            login: vi.fn(() => Promise.reject(new Error("unused"))),
            loginQr: vi.fn(() => new Promise<ZcaApiPort>(() => undefined)),
          }),
        },
        eventSink: {
          publishAuthorization: vi.fn(() => Promise.resolve()),
          publishDirectMessage: vi.fn(() => Promise.resolve()),
          publishDirectStatus: vi.fn(() => Promise.resolve()),
          publishDirectUndo: vi.fn(() => Promise.resolve()),
          publishGroupActivity: vi.fn(() => Promise.resolve()),
          publishLifecycle: vi.fn(() => Promise.resolve()),
        },
        lease,
        leaseRenewMs: 10_000,
        leaseTtlMs: 30_000,
        ownerId,
        secretPort: {
          load: vi.fn(() => Promise.resolve({ auth, zaloUid: auth.zaloUid })),
        },
      })
    const first = makePool("replica-a")
    const second = makePool("replica-b")
    const command = {
      runtime: { kind: "account" as const, id: "account-1" },
      workspaceId: "workspace-1",
    }

    await expect(first.startQr(command)).resolves.toEqual({ status: "started" })
    await expect(first.startQr(command)).resolves.toEqual({
      status: "coalesced",
    })
    await expect(second.startQr(command)).resolves.toEqual({
      status: "owned_elsewhere",
    })
    await first.shutdown()
    await expect(second.startQr(command)).resolves.toEqual({
      status: "started",
    })
    await second.shutdown()
  })

  it("serializes concurrent starts and a racing manual stop for one account", async () => {
    let resolveAcquire:
      | ((lease: { ownerId: string; fenceToken: string }) => void)
      | undefined
    const lease: AccountLeasePort = {
      acquire: vi.fn(
        () =>
          new Promise<AccountLease | null>((resolve) => {
            resolveAcquire = resolve
          }),
      ),
      renew: vi.fn(() => Promise.resolve(true)),
      release: vi.fn(() => Promise.resolve(true)),
    }
    const pool = new ZaloAccountPool({
      clientFactory: {
        create: () => ({
          login: vi.fn(() => Promise.reject(new Error("unused"))),
          loginQr: vi.fn(() => new Promise<ZcaApiPort>(() => undefined)),
        }),
      },
      eventSink: {
        publishAuthorization: vi.fn(() => Promise.resolve()),
        publishDirectMessage: vi.fn(() => Promise.resolve()),
        publishDirectStatus: vi.fn(() => Promise.resolve()),
        publishDirectUndo: vi.fn(() => Promise.resolve()),
        publishGroupActivity: vi.fn(() => Promise.resolve()),
        publishLifecycle: vi.fn(() => Promise.resolve()),
      },
      lease,
      leaseRenewMs: 10_000,
      leaseTtlMs: 30_000,
      ownerId: "replica-a",
      secretPort: {
        load: vi.fn(() => Promise.resolve({ auth, zaloUid: auth.zaloUid })),
      },
    })
    const command = {
      runtime: { kind: "account" as const, id: "account-race" },
      workspaceId: "workspace-1",
    }

    const first = pool.startQr(command)
    await vi.waitFor(() => expect(resolveAcquire).toBeTypeOf("function"))
    const duplicate = pool.startQr(command)
    const stop = pool.stop(command)
    resolveAcquire?.({ ownerId: "replica-a", fenceToken: "1" })

    await expect(first).resolves.toEqual({ status: "stopped" })
    await expect(duplicate).resolves.toEqual({ status: "stopped" })
    await expect(stop).resolves.toBeUndefined()
    expect(lease.acquire).toHaveBeenCalledTimes(1)
    expect(lease.release).toHaveBeenCalledTimes(1)
  })

  it("lets manual stop release the lease while reconnect login is still pending", async () => {
    let resolveLogin: ((api: ZcaApiPort) => void) | undefined
    const login = vi.fn(
      () =>
        new Promise<ZcaApiPort>((resolve) => {
          resolveLogin = resolve
        }),
    )
    const lease: AccountLeasePort = {
      acquire: vi.fn((_, ownerId) =>
        Promise.resolve({ ownerId, fenceToken: "1" }),
      ),
      renew: vi.fn(() => Promise.resolve(true)),
      release: vi.fn(() => Promise.resolve(true)),
    }
    const pool = new ZaloAccountPool({
      clientFactory: {
        create: () => ({
          login,
          loginQr: vi.fn(() => new Promise<ZcaApiPort>(() => undefined)),
        }),
      },
      eventSink: {
        publishAuthorization: vi.fn(() => Promise.resolve()),
        publishDirectMessage: vi.fn(() => Promise.resolve()),
        publishDirectStatus: vi.fn(() => Promise.resolve()),
        publishDirectUndo: vi.fn(() => Promise.resolve()),
        publishGroupActivity: vi.fn(() => Promise.resolve()),
        publishLifecycle: vi.fn(() => Promise.resolve()),
      },
      lease,
      leaseRenewMs: 10_000,
      leaseTtlMs: 30_000,
      ownerId: "replica-a",
      secretPort: {
        load: vi.fn(() => Promise.resolve({ auth, zaloUid: auth.zaloUid })),
      },
    })
    const command = {
      runtime: { kind: "account" as const, id: "account-pending-login" },
      workspaceId: "workspace-1",
    }

    const reconnect = pool.reconnect(command)
    await vi.waitFor(() => expect(login).toHaveBeenCalled())
    let stopped = false
    const stop = pool.stop(command).then(() => {
      stopped = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const stoppedWhilePending = stopped
    resolveLogin?.({
      getOwnId: () => Promise.resolve("uid-1"),
      getLabels: vi.fn(async () => ({
        labelData: [],
        version: 0,
        lastUpdateTime: 0,
      })),
      listGroups: vi.fn(async () => []),
      listen: () => ({ start: vi.fn(), stop: vi.fn() }),
      sendDirect: vi.fn(async () => ({
        messageIds: ["sent-1"],
        sentCount: 1,
      })),
      sendGroup: vi.fn(async () => ({
        messageIds: ["sent-group-1"],
        sentCount: 1,
      })),
      updateLabels: vi.fn(async ({ labelData, version }) => ({
        labelData,
        version: version + 1,
        lastUpdateTime: Date.now(),
      })),
    })
    await reconnect
    await stop

    expect(stoppedWhilePending).toBe(true)
    expect(lease.release).toHaveBeenCalledTimes(1)
  })
})
