import type { ZaloAccountAuth } from "@chatbotx.io/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AccountLeasePort,
  RuntimeEventSink,
  RuntimeOwnershipHooks,
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
  autoOpen = true
  handlers?: Parameters<ZcaApiPort["listen"]>[0]
  readonly start = vi.fn(() => {
    if (this.autoOpen) {
      this.handlers?.onConnected?.()
    }
  })
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
  getStickerResources = vi.fn(async () => [])
  nativeOperation = vi.fn(async () => ({ status: 1 }))

  listen(handlers: Parameters<ZcaApiPort["listen"]>[0]) {
    this.handlers = handlers
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
  private rejectQr?: (error: Error) => void
  cancel = vi.fn(() => {
    this.rejectQr?.(new Error("cancelled"))
    this.rejectQr = undefined
    return Promise.resolve()
  })

  loginQr(callback: Parameters<ZcaClientPort["loginQr"]>[0]) {
    this.qrCallback = callback
    return new Promise<ZcaApiPort>((resolve, reject) => {
      this.rejectQr = reject
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
  options: {
    renewError?: Error
    renewResult?: boolean
    account?: boolean
    initialDeadlineAt?: number
    leaseTtlMs?: number
    hold?: RuntimeOwnershipHooks["hold"]
  } = {},
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
    hold: options.hold,
    initialDeadlineAt: options.initialDeadlineAt,
    epoch: 3,
    eventSink: sink,
    lease,
    leaseRenewMs: 1000,
    leaseTtlMs: options.leaseTtlMs ?? 3000,
    ownerId: "owner-1",
    runtime: options.account
      ? { kind: "account", id: "account-1" }
      : { kind: "connect_session", id: "session-1" },
    ...(options.account ? { inboxId: "inbox-1" } : {}),
    workspaceId: "workspace-1",
  })
  return { client, events, lease, runtime, sink }
}

describe("ZaloAccountRuntime", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([
    "append",
    "snapshot",
  ] as const)("retries after a one-off %s rejection while publishing automatic connecting diagnostics", async (boundary) => {
    const { client, runtime, lease, sink } = makeHarness()
    const writeSnapshot = vi.fn<NonNullable<AccountLeasePort["writeSnapshot"]>>(
      () => Promise.resolve(true),
    )
    lease.writeSnapshot = writeSnapshot
    await runtime.reconnect(auth, auth.zaloUid)
    client.reconnectApis[0].close()
    await vi.waitFor(() => expect(runtime.snapshot().state).toBe("backoff"))
    if (boundary === "append") {
      vi.mocked(sink.publishLifecycle).mockRejectedValueOnce(
        new Error("stream unavailable"),
      )
    } else {
      writeSnapshot.mockRejectedValueOnce(new Error("snapshot unavailable"))
    }
    await vi.advanceTimersByTimeAsync(1500)
    expect(runtime.snapshot()).toMatchObject({ active: true, state: "backoff" })
    expect(client.reconnectApis).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(6000)
    expect(client.reconnectApis).toHaveLength(2)
    expect(runtime.snapshot().state).toBe("connected")
    await runtime.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    true,
    false,
  ])("fences an unconfirmed passive close and persists a hold when storage succeeds=%s", async (stored) => {
    const hold = vi.fn(async () => stored)
    const { client, runtime, lease, events } = makeHarness({
      account: true,
      hold,
    })
    await runtime.reconnect(async () => ({
      auth,
      zaloUid: auth.zaloUid,
      authFingerprint: "a".repeat(64),
    }))
    const api = client.reconnectApis[0]
    const closeConnection = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new Error("physical close unconfirmed")),
    )
    Object.assign(api, { closeConnection })
    api.handlers?.onDisconnected?.(1006, "network")
    await vi.waitFor(() =>
      expect(runtime.snapshot()).toMatchObject({
        active: false,
        settled: false,
        state: "stopped",
      }),
    )
    expect(hold).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          phase: "held",
          requiresAction: true,
          errorCategory: "unknown",
        }),
      }),
    )
    if (stored) {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "closed",
          diagnostics: expect.objectContaining({
            phase: "held",
            requiresAction: true,
          }),
        }),
      )
    }
    expect(lease.release).not.toHaveBeenCalled()
    await expect(runtime.reconnect(auth, auth.zaloUid)).rejects.toThrow(
      "cleanup is unconfirmed",
    )
    await expect(runtime.stop()).rejects.toThrow("physical close unconfirmed")
    await vi.advanceTimersByTimeAsync(600_000)
    expect(client.reconnectApis).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    closeConnection.mockResolvedValue(undefined)
    await runtime.stop()
    expect(lease.release).toHaveBeenCalledOnce()
  })

  it("does not stack stalled lease renewals and stops at the ownership deadline", async () => {
    const { lease, runtime } = makeHarness()
    vi.mocked(lease.renew).mockImplementation(
      () => new Promise(() => undefined),
    )
    await runtime.startQr()
    await vi.advanceTimersByTimeAsync(3000)
    expect(lease.renew).toHaveBeenCalledOnce()
    expect(runtime.snapshot()).toMatchObject({
      active: false,
      state: "stopped",
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it("subtracts secret loading time from the initial login deadline", async () => {
    const deadlineAt = Date.now() + 30_000
    const { client, runtime } = makeHarness({
      account: true,
      initialDeadlineAt: deadlineAt,
      leaseTtlMs: 60_000,
    })
    let rejectLogin: ((error: Error) => void) | undefined
    vi.spyOn(client, "login").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectLogin = reject
        }),
    )
    client.cancel.mockImplementation(() => {
      rejectLogin?.(new Error("aborted"))
      return Promise.resolve()
    })
    const connecting = runtime.reconnect(() => {
      vi.setSystemTime(Date.now() + 20_000)
      return Promise.resolve({ auth, zaloUid: auth.zaloUid })
    })
    await vi.waitFor(() => expect(client.login).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(deadlineAt - Date.now())
    expect(client.cancel).toHaveBeenCalledOnce()
    await connecting
    await runtime.stop()
  })

  it("preserves timestamps and retry diagnostics on an isolated error", async () => {
    const { client, runtime, events } = makeHarness()
    await runtime.reconnect(auth, auth.zaloUid)
    const connected = events.find(
      (event) => (event as { type: string }).type === "connected",
    ) as { diagnostics: { connectedAt: string } }
    client.reconnectApis[0].handlers?.onError?.("network")
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "runtime_diagnostic",
          diagnostics: expect.objectContaining({
            connectedAt: connected.diagnostics.connectedAt,
            errorCategory: "network",
          }),
        }),
      ),
    )
    await runtime.stop()
  })

  it("reloads ciphertext identity and persists changed cookies again after reconnect", async () => {
    const { client, runtime, sink } = makeHarness({ account: true })
    const apis: FakeApi[] = []
    vi.spyOn(client, "login").mockImplementation(() => {
      const value = `rotated-${apis.length + 1}`
      const api = Object.assign(new FakeApi(auth.zaloUid), {
        getAuthorization: () => ({
          ...auth,
          cookie: [{ key: "zpw_sek", value }],
        }),
      })
      apis.push(api)
      return Promise.resolve(api)
    })
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        auth,
        zaloUid: auth.zaloUid,
        authFingerprint: "a".repeat(64),
      })
      .mockResolvedValue({
        auth: { ...auth, cookie: [{ key: "zpw_sek", value: "rotated-1" }] },
        zaloUid: auth.zaloUid,
        authFingerprint: "b".repeat(64),
      })
    await runtime.reconnect(load)
    expect(sink.publishAuthorization).toHaveBeenCalledOnce()
    apis[0].close()
    await vi.waitFor(() => expect(runtime.snapshot().state).toBe("backoff"))
    await vi.advanceTimersByTimeAsync(1500)
    expect(load).toHaveBeenCalledTimes(2)
    expect(sink.publishAuthorization).toHaveBeenCalledTimes(2)
    expect(sink.publishAuthorization).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedCiphertextFingerprint: "b".repeat(64),
      }),
      expect.anything(),
    )
    await runtime.stop()
  })

  it.each([
    3000, 3003,
  ])("holds close code %s without revoking authorization or retrying", async (code) => {
    const { client, events, runtime } = makeHarness({ account: true })
    await runtime.reconnect(auth, auth.zaloUid)
    client.reconnectApis[0].handlers?.onDisconnected?.(
      code,
      "provider-private-reason",
    )
    client.reconnectApis[0].handlers?.onClosed("provider-private-reason", code)
    await vi.waitFor(() =>
      expect(runtime.snapshot()).toMatchObject({
        active: false,
        settled: true,
      }),
    )
    await vi.advanceTimersByTimeAsync(600_000)
    expect(client.reconnectApis).toHaveLength(1)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "closed",
        diagnostics: expect.objectContaining({
          phase: "held",
          closeCode: code,
          requiresAction: true,
        }),
      }),
    )
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "reauthorization_required" }),
    )
    expect(JSON.stringify(events)).not.toContain("provider-private-reason")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps an open socket after an isolated SDK error", async () => {
    const { client, runtime } = makeHarness()
    await runtime.reconnect(auth, auth.zaloUid)
    client.reconnectApis[0].handlers?.onError?.("network")
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.snapshot().state).toBe("connected")
    expect(client.reconnectApis).toHaveLength(1)
    await runtime.stop()
  })

  it("publishes changed SDK cookies only after verified socket open with the source ciphertext fingerprint", async () => {
    const { client, runtime, sink } = makeHarness({ account: true })
    const api = Object.assign(new FakeApi(auth.zaloUid), {
      getAuthorization: () => ({
        ...auth,
        cookie: [{ key: "zpw_sek", value: "rotated" }],
      }),
    })
    api.autoOpen = false
    vi.spyOn(client, "login").mockResolvedValue(api)
    await runtime.reconnect(async () => ({
      auth,
      zaloUid: auth.zaloUid,
      authFingerprint: "a".repeat(64),
    }))
    expect(sink.publishAuthorization).not.toHaveBeenCalled()
    api.handlers?.onConnected?.()
    await vi.waitFor(() =>
      expect(sink.publishAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: "refresh",
          expectedCiphertextFingerprint: "a".repeat(64),
          socketAttempt: 1,
          sequence: expect.any(Number),
        }),
        expect.anything(),
      ),
    )
    await runtime.stop()
  })

  it("does not admit sends or publish connected until the current socket opens", async () => {
    const { client, events, runtime } = makeHarness()
    const api = new FakeApi(auth.zaloUid)
    api.autoOpen = false
    vi.spyOn(client, "login").mockResolvedValue(api)
    await runtime.reconnect(auth, auth.zaloUid)
    expect(runtime.snapshot().state).toBe("reconnecting")
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "connected" }),
    )
    await expect(
      runtime.sendDirect({
        recipientId: "user",
        text: "hello",
        attachments: [],
      }),
    ).rejects.toThrow()
    api.handlers?.onConnected?.()
    await vi.waitFor(() => expect(runtime.snapshot().state).toBe("connected"))
    expect(
      events.filter(
        (event) => (event as { type: string }).type === "connected",
      ),
    ).toHaveLength(1)
    await runtime.stop()
  })

  it("deduplicates disconnected/closed and ignores late open and data from that socket", async () => {
    const { client, events, runtime } = makeHarness()
    await runtime.reconnect(auth, auth.zaloUid)
    const api = client.reconnectApis[0]
    api.handlers?.onDisconnected?.(1006, "network")
    api.handlers?.onClosed("network", 1006)
    await vi.waitFor(() => expect(runtime.snapshot().state).toBe("backoff"))
    const before = events.length
    api.handlers?.onConnected?.()
    api.handlers?.onDirectStatus({
      providerMessageId: "late",
      threadId: "user",
      status: "read",
      timestampMs: 1,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toHaveLength(before)
    expect(
      events.filter((event) => (event as { type: string }).type === "closed"),
    ).toHaveLength(1)
    await runtime.stop()
  })

  it("rejects sticker reads before socket open and immediately after close", async () => {
    const { client, runtime } = makeHarness()
    const api = new FakeApi(auth.zaloUid)
    api.autoOpen = false
    vi.spyOn(client, "login").mockResolvedValue(api)
    await runtime.reconnect(auth, auth.zaloUid)
    await expect(runtime.getStickerResources(["123"])).rejects.toThrow()
    api.handlers?.onConnected?.()
    await vi.waitFor(() => expect(runtime.snapshot().state).toBe("connected"))
    await expect(runtime.getStickerResources(["123"])).resolves.toEqual([])
    expect(api.getStickerResources).toHaveBeenCalledOnce()
    api.handlers?.onDisconnected?.(1006, "network")
    await expect(runtime.getStickerResources(["123"])).rejects.toThrow()
    expect(api.getStickerResources).toHaveBeenCalledOnce()
    await runtime.stop()
  })

  it("rejects native operations before socket open and immediately after close", async () => {
    const { client, runtime } = makeHarness()
    const api = new FakeApi(auth.zaloUid)
    api.autoOpen = false
    vi.spyOn(client, "login").mockResolvedValue(api)
    const input = {
      operation: "undo" as const,
      attemptCommandId: "cmd",
      requestHash: "hash",
      threadType: "user" as const,
      threadId: "peer",
      providerMessageId: "message",
      providerClientMessageId: "client-message",
      providerOwnerId: auth.zaloUid,
    }
    await runtime.reconnect(auth, auth.zaloUid)
    await expect(runtime.nativeOperation(input)).rejects.toThrow()
    api.handlers?.onConnected?.()
    await vi.waitFor(() => expect(runtime.snapshot().state).toBe("connected"))
    await expect(runtime.nativeOperation(input)).resolves.toEqual({ status: 1 })
    api.handlers?.onDisconnected?.(1006, "network")
    await expect(runtime.nativeOperation(input)).rejects.toThrow()
    expect(api.nativeOperation).toHaveBeenCalledOnce()
    await runtime.stop()
  })

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
      expiresAt: new Date(Date.now() + 100_000).toISOString(),
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
    await vi.waitFor(() => expect(client.qrCallback).not.toBe(qrCallback))
    const secondCallback = client.qrCallback
    secondCallback?.({ type: "expired", retry })
    await vi.waitFor(() => expect(client.qrCallback).not.toBe(secondCallback))
    client.qrCallback?.({ type: "expired", retry })
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: "reauthorization_required" }),
      ),
    )
    expect(retry).not.toHaveBeenCalled()
    expect(client.cancel).toHaveBeenCalledTimes(3)
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

it("bounds pending account messages and restores readiness after draining", async () => {
  const { client, runtime, sink } = makeHarness({ account: true })
  await runtime.reconnect(auth, auth.zaloUid)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.mocked(sink.publishDirectMessage).mockImplementation(() => blocked)
  const message = {
    providerMessageId: "m",
    threadId: "peer",
    threadType: "user" as const,
    senderId: "peer",
    recipientId: "uid-1",
    timestampMs: 1,
    msgType: "webchat",
    isSelf: false,
    text: "hello",
    attachments: [],
  }
  for (let i = 0; i < 30; i++) {
    client.reconnectApis[0].handlers?.onDirectMessage({
      ...message,
      providerMessageId: String(i),
    })
  }
  expect(runtime.snapshot()).toMatchObject({ messageReady: false })
  release()
  await vi.waitFor(() =>
    expect(runtime.snapshot()).toMatchObject({ messageReady: true }),
  )
  expect(sink.publishDirectMessage).toHaveBeenCalledTimes(20)
  await runtime.stop()
})

it("caps all account callback reservations at 200 while allowing independent accounts to drain", async () => {
  const harnesses = Array.from({ length: 11 }, () =>
    makeHarness({ account: true }),
  )
  const releases: (() => void)[] = []
  for (const { client, runtime, sink } of harnesses) {
    await runtime.reconnect(auth, auth.zaloUid)
    const blocked = new Promise<void>((resolve) => releases.push(resolve))
    vi.mocked(sink.publishDirectMessage).mockImplementation(() => blocked)
    for (let i = 0; i < 20; i++) {
      client.reconnectApis[0].handlers?.onDirectMessage({
        providerMessageId: String(i),
        threadId: "p",
        threadType: "user",
        senderId: "p",
        recipientId: "uid-1",
        timestampMs: 1,
        msgType: "webchat",
        isSelf: false,
        text: "hello",
        attachments: [],
      })
    }
  }
  expect(harnesses[10].runtime.snapshot()).toMatchObject({
    messageReady: false,
  })
  for (const release of releases) {
    release()
  }
  await vi.waitFor(() =>
    expect(harnesses.every((h) => h.runtime.snapshot().messageReady)).toBe(
      true,
    ),
  )
  expect(
    harnesses.reduce(
      (total, h) =>
        total + vi.mocked(h.sink.publishDirectMessage).mock.calls.length,
      0,
    ),
  ).toBe(200)
  await Promise.all(harnesses.map((h) => h.runtime.stop()))
})
