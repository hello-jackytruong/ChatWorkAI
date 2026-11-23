import { zaloAccountTransportKeys } from "@chatbotx.io/sdk"
import type {
  AccountLease,
  AccountLeasePort,
  AccountRuntimeScope,
} from "./ports"

type AppendInput = {
  streamKey: string
  maxLen: number
  fields: string[]
}

type RedisScriptClient = {
  eval: (
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>
}

const SNAPSHOT_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[2], ARGV[2], "PX", ARGV[3])
return 1
`

const ACQUIRE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return nil end
local fence = redis.call("INCR", KEYS[2])
local value = ARGV[1] .. ":" .. tostring(fence)
redis.call("SET", KEYS[1], value, "PX", ARGV[2], "NX")
return tostring(fence)
`

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return 1
`

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
return 1
`

const IS_OWNED_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return 1 end
return 0
`

const APPEND_IF_OWNED_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return nil end
if redis.call("XLEN", KEYS[2]) >= tonumber(ARGV[2]) then
  return redis.error_reply("Zalo Account event stream capacity exceeded")
end
local args = {KEYS[2], "*"}
for index = 3, #ARGV do table.insert(args, ARGV[index]) end
return redis.call("XADD", unpack(args))
`

const leaseKey = (scope: AccountRuntimeScope) =>
  zaloAccountTransportKeys.lease(scope)

const fenceKey = (scope: AccountRuntimeScope) =>
  zaloAccountTransportKeys.fence(scope)

export class RedisAccountLeaseStore implements AccountLeasePort {
  private readonly redis: RedisScriptClient

  constructor(redis: RedisScriptClient) {
    this.redis = redis
  }

  async writeSnapshot(
    scope: AccountRuntimeScope,
    lease: AccountLease,
    serialized: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (Buffer.byteLength(serialized) > 2048) {
      throw new Error("Zalo Account snapshot exceeds limit")
    }
    return (
      Number(
        await this.redis.eval(
          SNAPSHOT_SCRIPT,
          2,
          leaseKey(scope),
          zaloAccountTransportKeys.snapshot(scope),
          `${lease.ownerId}:${lease.fenceToken}`,
          serialized,
          Math.max(60_000, ttlMs),
        ),
      ) === 1
    )
  }

  async acquire(
    scope: AccountRuntimeScope,
    ownerId: string,
    ttlMs: number,
  ): Promise<AccountLease | null> {
    const fence = await this.redis.eval(
      ACQUIRE_SCRIPT,
      2,
      leaseKey(scope),
      fenceKey(scope),
      ownerId,
      ttlMs,
    )
    return fence === null ? null : { ownerId, fenceToken: String(fence) }
  }

  async appendIfOwned(
    scope: AccountRuntimeScope,
    lease: AccountLease,
    input: AppendInput,
  ): Promise<string | null> {
    if (input.fields.length === 0 || input.fields.length % 2 !== 0) {
      throw new Error("Redis stream fields must contain key/value pairs")
    }
    const result = await this.redis.eval(
      APPEND_IF_OWNED_SCRIPT,
      2,
      leaseKey(scope),
      input.streamKey,
      `${lease.ownerId}:${lease.fenceToken}`,
      input.maxLen,
      ...input.fields,
    )
    return result === null ? null : String(result)
  }

  async renew(
    scope: AccountRuntimeScope,
    lease: AccountLease,
    ttlMs: number,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_SCRIPT,
      1,
      leaseKey(scope),
      `${lease.ownerId}:${lease.fenceToken}`,
      ttlMs,
    )
    return Number(result) === 1
  }

  async isOwned(
    scope: AccountRuntimeScope,
    lease: AccountLease,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      IS_OWNED_SCRIPT,
      1,
      leaseKey(scope),
      `${lease.ownerId}:${lease.fenceToken}`,
    )
    return Number(result) === 1
  }

  async release(
    scope: AccountRuntimeScope,
    lease: AccountLease,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE_SCRIPT,
      1,
      leaseKey(scope),
      `${lease.ownerId}:${lease.fenceToken}`,
    )
    return Number(result) === 1
  }
}

/** Deterministic Redis-script test double; production uses RedisAccountLeaseStore with ioredis. */
export class InMemoryLeaseScriptClient implements RedisScriptClient {
  private now = 0
  private readonly values = new Map<
    string,
    { value: string; expiresAt: number }
  >()
  private readonly counters = new Map<string, bigint>()
  private readonly streamCounters = new Map<string, number>()

  advanceBy(ms: number): void {
    this.now += ms
  }

  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const keys = args.slice(0, numberOfKeys).map(String)
    const argv = args.slice(numberOfKeys).map(String)
    const current = this.values.get(keys[0])
    if (current && current.expiresAt <= this.now) {
      this.values.delete(keys[0])
    }
    const live = this.values.get(keys[0])
    if (script === ACQUIRE_SCRIPT) {
      if (live) {
        return Promise.resolve(null)
      }
      const fence = (this.counters.get(keys[1]) ?? 0n) + 1n
      this.counters.set(keys[1], fence)
      this.values.set(keys[0], {
        value: `${argv[0]}:${fence}`,
        expiresAt: this.now + Number(argv[1]),
      })
      return Promise.resolve(String(fence))
    }
    if (script === IS_OWNED_SCRIPT) {
      return Promise.resolve(live?.value === argv[0] ? 1 : 0)
    }
    if (!live || live.value !== argv[0]) {
      return Promise.resolve(script === APPEND_IF_OWNED_SCRIPT ? null : 0)
    }
    if (script === SNAPSHOT_SCRIPT) {
      this.values.set(keys[1], {
        value: argv[1],
        expiresAt: this.now + Number(argv[2]),
      })
      return Promise.resolve(1)
    }
    if (script === APPEND_IF_OWNED_SCRIPT) {
      const next = (this.streamCounters.get(keys[1]) ?? 0) + 1
      this.streamCounters.set(keys[1], next)
      return Promise.resolve(`${next}-0`)
    }
    if (script === RENEW_SCRIPT) {
      live.expiresAt = this.now + Number(argv[1])
      return Promise.resolve(1)
    }
    if (script === RELEASE_SCRIPT) {
      this.values.delete(keys[0])
      return Promise.resolve(1)
    }
    throw new Error("Unknown lease script")
  }
}
