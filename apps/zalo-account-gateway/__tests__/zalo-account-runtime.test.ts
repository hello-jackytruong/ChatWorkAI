import type { ZaloAccountAuth } from "@chatbotx.io/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AccountLeasePort,
  RuntimeEventSink,
  ZcaApiPort,
  ZcaClientPort,
} from "../src/runtime/ports"
import { ReconnectPolicy } from "../src/runtime/reconnect-policy"
import { ZaloAccountRuntime } from "../src/runtime/zalo-account-runtime"

const auth: ZaloAccountAuth = {
  authType: "custom",
  cookie: [{ key: "zpw_sek", value: "secret-cookie" }],
  imei: "secret-imei",
  userAgent: "secret-agent",
  zaloUid: "uid-1",
}

class FakeApi implements ZcaApiPort {
  readonly stop = vi.fn()
  readonly start = vi.fn()
  private readonly ownId: string
  private onClosed?: (reason: string) => void

  constructor(ownId: string) {
    this.ownId = ownId
  }

  getOwnId = vi.fn(async () => this.ownId)
  getLabels = vi.fn(async () => ({
    labelData: [],
    version: 0,
    lastUpdateTime: 0,
  }))
  listGroups = vi.fn(async () => [])

  listen(handlers: Parameters<ZcaApiPort["listen"]>[0]) {
    this.onClosed = handlers.onClosed
    return { start: this.start, stop: this.stop }
  }

  sendDirect = vi.fn(async () => ({ messageIds: ["sent-1"], sentCount: 1 }))
  sendGroup = vi.fn(async () => ({
    messageIds: ["sent-group-1"],
    sentCount: 1,
  }))
  updateLabels = vi.fn(async ({ labelData, version }) => ({
    labelData,
    version: version + 1,
    lastUpdateTime: Date.now(),
  }))

  close(reason = "network") {
    this.onClosed?.(reason)
  }
}

class FakeClient implements ZcaClientPort {
  qrCallback?: Parameters<ZcaClientPort["loginQr"]>[0]
  readonly qrApi = new FakeApi("uid-1")
  readonly reconnectApis: FakeApi[] = []
  private resolveQr?: (api: ZcaApiPort) => void

  loginQr(callback: Parameters<ZcaClientPort["loginQr"]>[0]) {
    this.qrCallback = callback
    return new Promise<ZcaApiPort>((resolve) => {
      this.resolveQr = resolve
    })
  }

  completeQr() {
    this.resolveQr?.(this.qrApi)
  }

  login(savedAuth: ZaloAccountAuth) {
    const api = new FakeApi(savedAuth.zaloUid)
    this.reconnectApis.push(api)
    return Promise.resolve(api)
  }
}

const makeHarness = (
  options: { renewError?: Error; renewResult?: boolean } = {},
) => {
  const events: unknown[] = []
  const lease: AccountLeasePort = {
    acquire: vi.fn(async () => ({ ownerId: "owner-1", fenceToken: "7" })),
    renew: vi.fn(() =>
      options.renewError
        ? Promise.reject(options.renewError)
        : Promise.resolve(options.renewResult ?? true),
    ),
    release: vi.fn(async () => true),
  }
  const sink: RuntimeEventSink = {
    publishAuthorization: vi.fn((event) => {
      events.push(event)
      return Promise.resolve()
    }),
    publishLifecycle: vi.fn((event) => {
      events.push(event)
      return Promise.resolve()
    }),
    publishDirectMessage: vi.fn((event) => {
      events.push(event)
      return Promise.resolve()
    }),
    publishDirectStatus: vi.fn((event) => {
      events.push(event)
      return Promise.resolve()
    }),
    publishDirectUndo: vi.fn((event) => {
      events.push(event)
      return Promise.resolve()
    }),
    publishGroupActivity: vi.fn((event) => {
      events.push(event)
      return Promise.resolve()
    }),
  }
  const client = new FakeClient()
  const runtime = new ZaloAccountRuntime({
    clientFactory: { create: () => client },
    epoch: 3,
    eventSink: sink,
    lease,
    leaseRenewMs: 1000,
    leaseTtlMs: 3000,
    ownerId: "owner-1",
    runtime: { kind: "connect_session", id: "session-1" },
    workspaceId: "workspace-1",
  })
  return { client, events, lease, runtime, sink }
}

describe("ZaloAccountRuntime", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("emits QR/scanned/auth then releases the temporary session socket", async () => {
    const { client, events, lease, runtime } = makeHarness()
    await expect(runtime.startQr()).resolves.toEqual({ status: "started" })
    await vi.waitFor(() => expect(client.qrCallback).toBeTypeOf("function"))
    const qrCallback = client.qrCallback
    if (!qrCallback) {
      throw new Error("Expected QR callback to be registered")
    }

    qrCallback({
      type: "generated",
      imageDataUrl: "data:image/png;base64,QUJD",
      expiresAt: "2026-11-19T17:00:00.000Z",
    })
    qrCallback({ type: "scanned", displayName: "Jacky" })
    qrCallback({ type: "credentials", auth })
    client.completeQr()
    await vi.waitFor(() =>
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "qr_generated" }),
          expect.objectContaining({ type: "qr_scanned" }),
          expect.objectContaining({ type: "authorization_obtained", auth }),
        ]),
      ),
    )

    await vi.waitFor(() => expect(runtime.snapshot().active).toBe(false))
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "connected" }),
    )
    expect(client.qrApi.stop).toHaveBeenCalled()
    expect(lease.release).toHaveBeenCalledTimes(1)

    const lifecycleOnly = events.filter(
      (event) => (event as { type: string }).type !== "authorization_obtained",
    )
    const serialized = JSON.stringify(lifecycleOnly)
    expect(serialized).not.toContain("secret-cookie")
    expect(serialized).not.toContain("secret-imei")
    expect(serialized).not.toContain("secret-agent")
  })

  it("stops on lease loss and suppresses stale SDK callbacks", async () => {
    const { client, events, runtime } = makeHarness({ renewResult: false })
    await runtime.startQr()
    await vi.waitFor(() => expect(client.qrCallback).toBeTypeOf("function"))
    const qrCallback = client.qrCallback
    if (!qrCallback) {
      throw new Error("Expected QR callback to be registered")
    }

    await vi.advanceTimersByTimeAsync(1000)
    const eventCount = events.length
    qrCallback({ type: "scanned", displayName: "Jacky" })
    await Promise.resolve()

    expect(runtime.snapshot().state).toBe("stopped")
    expect(events).toHaveLength(eventCount)
  })

  it("stops when lease renewal rejects instead of leaving a stale listener active", async () => {
    const { client, events, runtime } = makeHarness({
      renewError: new Error("redis unavailable"),
    })
    await runtime.startQr()
    await vi.waitFor(() => expect(client.qrCallback).toBeTypeOf("function"))
    const qrCallback = client.qrCallback
    if (!qrCallback) {
      throw new Error("Expected QR callback to be registered")
    }

    await vi.advanceTimersByTimeAsync(1000)
    const eventCount = events.length
    qrCallback({ type: "scanned", displayName: "stale" })
    await Promise.resolve()

    expect(runtime.snapshot().state).toBe("stopped")
    expect(events).toHaveLength(eventCount)
  })

  it("publishes QR scan before authorization even when the sink is slow", async () => {
    const { client, runtime, sink } = makeHarness()
    let releaseScan: (() => void) | undefined
    vi.mocked(sink.publishLifecycle).mockImplementation((event) => {
      if (event.type !== "qr_scanned") {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        releaseScan = resolve
      })
    })

    await runtime.startQr()
    await vi.waitFor(() => expect(client.qrCallback).toBeTypeOf("function"))
    const qrCallback = client.qrCallback
    if (!qrCallback) {
      throw new Error("Expected QR callback to be registered")
    }
    qrCallback({ type: "scanned", displayName: "Jacky" })
    qrCallback({ type: "credentials", auth })
    client.completeQr()
    await vi.waitFor(() => expect(releaseScan).toBeTypeOf("function"))

    expect(sink.publishAuthorization).not.toHaveBeenCalled()
    releaseScan?.()
    await vi.waitFor(() => expect(sink.publishAuthorization).toHaveBeenCalled())
    expect(
      vi.mocked(sink.publishLifecycle).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(sink.publishAuthorization).mock.invocationCallOrder[0] ?? 0,
    )
  })

  it("coalesces a duplicate active start instead of replacing its runtime", async () => {
    const { lease, runtime } = makeHarness()

    await expect(runtime.startQr()).resolves.toEqual({ status: "started" })
    await expect(runtime.startQr()).resolves.toEqual({ status: "coalesced" })
    expect(lease.acquire).toHaveBeenCalledTimes(1)
  })

  it("releases its lease even when the closed lifecycle event cannot be published", async () => {
    const { lease, runtime, sink } = makeHarness()
    await runtime.startQr()
    vi.mocked(sink.publishLifecycle).mockRejectedValueOnce(
      new Error("event sink unavailable"),
    )

    await expect(runtime.stop("manual")).rejects.toThrow(
      "event sink unavailable",
    )
    expect(lease.release).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot()).toMatchObject({
      active: false,
      state: "stopped",
    })
  })

  it("allows only two QR retries and requires a fresh session on the third expiry", async () => {
    const { client, events, runtime } = makeHarness()
    await runtime.startQr()
    await vi.waitFor(() => expect(client.qrCallback).toBeTypeOf("function"))
    const qrCallback = client.qrCallback
    if (!qrCallback) {
      throw new Error("Expected QR callback to be registered")
    }
    const retry = vi.fn()

    qrCallback({ type: "expired", retry })
    qrCallback({ type: "expired", retry })
    qrCallback({ type: "expired", retry })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: "reauthorization_required" }),
      ),
    )

    expect(retry).toHaveBeenCalledTimes(2)
    expect(runtime.snapshot().state).toBe("reauth_required")
  })

  it("rejects reconnect when the saved session resolves to a different UID", async () => {
    const { client, events, runtime } = makeHarness()
    client.login = vi.fn(async () => new FakeApi("uid-other"))

    await expect(runtime.reconnect(auth, "uid-1")).resolves.toEqual({
      status: "reauthorization_required",
    })
    expect(events).toContainEqual(
      expect.objectContaining({ type: "reauthorization_required" }),
    )
  })

  it("does not reconnect after a manual stop", async () => {
    const { client, runtime } = makeHarness()
    await runtime.reconnect(auth, "uid-1")
    client.reconnectApis.at(-1)?.close()
    await runtime.stop("manual")
    await vi.runAllTimersAsync()

    expect(client.reconnectApis).toHaveLength(1)
  })

  it("keeps the response-seeded label version and rejects stale writes", async () => {
    const { client, runtime } = makeHarness()
    await runtime.reconnect(auth, "uid-1")
    const api = client.reconnectApis[0]
    if (!api) {
      throw new Error("Expected a connected API")
    }
    api.getLabels
      .mockResolvedValueOnce({ labelData: [], version: 5, lastUpdateTime: 10 })
      .mockResolvedValueOnce({ labelData: [], version: 4, lastUpdateTime: 9 })

    await expect(runtime.getLabels()).resolves.toMatchObject({ version: 5 })
    await expect(runtime.getLabels()).resolves.toMatchObject({ version: 5 })
    await expect(
      runtime.updateLabels({ expectedVersion: 4, labelData: [] }),
    ).rejects.toThrow("label version conflict")
    expect(api.updateLabels).not.toHaveBeenCalled()
  })
})

describe("ReconnectPolicy", () => {
  it("opens the five-in-five-minutes circuit breaker", () => {
    let now = 0
    const policy = new ReconnectPolicy(
      () => now,
      () => 0,
    )
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(policy.recordPassiveClose().reauthorize).toBe(false)
      now += 30_000
    }
    expect(policy.recordPassiveClose()).toEqual({
      reauthorize: true,
      delayMs: 0,
    })
  })
})
