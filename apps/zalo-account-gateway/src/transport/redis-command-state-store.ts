import type { Redis } from "@chatbotx.io/redis"
import { zaloAccountTransportKeys } from "@chatbotx.io/sdk"
import type { CommandStateStore } from "./command-executor"

export class RedisCommandStateStore implements CommandStateStore {
  private readonly redis: Pick<Redis, "get" | "set">

  constructor(redis: Pick<Redis, "get" | "set">) {
    this.redis = redis
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(
      zaloAccountTransportKeys.commandState(key),
      JSON.stringify({ status: "pending" }),
      "PX",
      ttlMs,
      "NX",
    )
    return result === "OK"
  }

  async get(key: string) {
    const value = await this.redis.get(
      zaloAccountTransportKeys.commandState(key),
    )
    if (!value) {
      return
    }
    return JSON.parse(value) as Awaited<ReturnType<CommandStateStore["get"]>>
  }

  async complete(
    key: string,
    state: Parameters<CommandStateStore["complete"]>[1],
    ttlMs: number,
  ): Promise<void> {
    await this.redis.set(
      zaloAccountTransportKeys.commandState(key),
      JSON.stringify(state),
      "PX",
      ttlMs,
    )
  }
}
