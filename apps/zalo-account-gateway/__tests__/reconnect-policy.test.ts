import { expect, it } from "vitest"
import { ReconnectPolicy } from "../src/runtime/reconnect-policy"

it("keeps the failure budget across brief opens and long jitter delays", () => {
  let now = 0
  const policy = new ReconnectPolicy(
    () => now,
    () => 1,
  )
  for (let index = 0; index < 4; index += 1) {
    const decision = policy.recordPassiveClose()
    expect(decision.reauthorize).toBe(false)
    policy.connected()
    now += decision.delayMs + 100_000
  }
  expect(policy.recordPassiveClose().reauthorize).toBe(true)
})
