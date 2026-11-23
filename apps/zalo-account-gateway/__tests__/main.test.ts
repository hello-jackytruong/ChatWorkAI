import { EventEmitter } from "node:events"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  env: {},
  redis: undefined as unknown,
  server: undefined as unknown,
  list: vi.fn(),
  reconnect: vi.fn(),
  shutdown: vi.fn(),
  starts: vi.fn(),
  stopConsumer: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  readiness: undefined as (() => boolean) | undefined,
}))
vi.mock("../src/env", () => ({ resolveGatewayEnv: () => mocks.env }))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  takeDirectSendCapacity: vi.fn(),
  zaloAccountGroupService: {},
  zaloAccountLabelService: {},
  zaloAccountSendAttemptService: {},
  zaloAccountService: { listActiveRuntimeAccounts: mocks.list },
}))
vi.mock("@chatbotx.io/business/zalo-account/native-operations", () => ({
  zaloAccountMessageOperationsService: {},
}))
vi.mock("@chatbotx.io/business/zalo-account/runtime-state", () => ({
  zaloAccountRuntimeStateService: {},
}))
vi.mock("@chatbotx.io/logger", () => ({ getChildLogger: () => mocks.logger }))
vi.mock("@chatbotx.io/redis", () => ({
  createRedisConnection: () => mocks.redis,
}))
vi.mock("../src/server", () => ({
  createGatewayServer: (options: { isReady: () => boolean }) => {
    mocks.readiness = options.isReady
    return mocks.server
  },
}))
vi.mock("../src/runtime/zalo-account-pool", () => ({
  ZaloAccountPool: class {
    reconnect = mocks.reconnect
    shutdown = mocks.shutdown
    isMessageReady = () => true
  },
}))
vi.mock("../src/runtime/zca-client", () => ({
  zcaClientFactory: { create: vi.fn() },
}))
vi.mock("../src/transport/redis-command-consumer", () => ({
  RedisCommandConsumer: class {
    start = mocks.starts
    stop = mocks.stopConsumer
    isReady = () => true
  },
}))
const { main } = await import("../src/main")
let redis: EventEmitter & {
  status: string
  connect: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}
let server: EventEmitter & {
  listen: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  closeAllConnections: ReturnType<typeof vi.fn>
}
let signal: (() => Promise<void>) | undefined
let settleConsumer: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.env = {
    enabled: true,
    ownerId: "test",
    redisUrl: "redis://fixture",
    port: 3999,
    host: "127.0.0.1",
    leaseRenewMs: 10_000,
    leaseTtlMs: 30_000,
  }
  redis = Object.assign(new EventEmitter(), {
    status: "ready",
    connect: vi.fn(() => {
      redis.emit("ready")
      return Promise.resolve()
    }),
    quit: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(),
  })
  server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_port, _host, callback) => callback()),
    close: vi.fn((callback) => callback()),
    closeAllConnections: vi.fn(),
  })
  mocks.redis = redis
  mocks.server = server
  mocks.list.mockResolvedValue([])
  mocks.starts.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        settleConsumer = resolve
      }),
  )
  mocks.stopConsumer.mockImplementation(() => settleConsumer?.())
  mocks.shutdown.mockResolvedValue(undefined)
  vi.spyOn(process, "once").mockImplementation(((event, callback) => {
    if (event === "SIGTERM") {
      signal = callback as () => Promise<void>
    }
    return process
  }) as typeof process.once)
})
afterEach(async () => {
  await signal?.()
  signal = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it("starts HTTP and the command consumer before waiting on a slow restored account", async () => {
  let finishLogin: (() => void) | undefined
  mocks.list
    .mockResolvedValueOnce([{ id: "1", workspaceId: "w", inboxId: "i" }])
    .mockResolvedValue([])
  mocks.reconnect.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishLogin = () => resolve({ status: "started" })
      }),
  )
  mocks.shutdown.mockImplementation(async () => finishLogin?.())
  await main()
  expect(server.listen).toHaveBeenCalledOnce()
  expect(mocks.starts).toHaveBeenCalledOnce()
  expect(mocks.readiness?.()).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.reconnect).toHaveBeenCalledOnce()
  expect(mocks.readiness?.()).toBe(true)
  for (let index = 0; index < 20; index += 1) {
    redis.emit("ready")
  }
  expect(mocks.starts).toHaveBeenCalledOnce()
  expect(mocks.list).toHaveBeenCalledOnce()
  finishLogin?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(1)
})

it("backs off a repeatedly failing consumer without an immediate recovery loop", async () => {
  mocks.starts.mockRejectedValue(new Error("private-provider-error"))
  await main()
  await vi.advanceTimersByTimeAsync(100)
  expect(mocks.starts.mock.calls.length).toBeLessThanOrEqual(2)
  expect(vi.getTimerCount()).toBe(1)
  expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(
    "private-provider-error",
  )
})
