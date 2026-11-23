import { describe, expect, it, vi } from "vitest"

const { evalRedis, useExisting } = vi.hoisted(() => ({
  evalRedis: vi.fn(),
  useExisting: vi.fn(),
}))
vi.mock("@chatbotx.io/redis", () => ({ cacheConnections: { useExisting } }))

import {
  takeDirectSendCapacity,
  takeGroupSendCapacity,
} from "../src/zalo-account/group-rate-limit"

describe("Zalo Account atomic send capacity", () => {
  it("uses one 60/minute direct bucket and returns a structured delay", async () => {
    useExisting.mockResolvedValue({ eval: evalRedis })
    evalRedis.mockResolvedValue(1234)
    await expect(
      takeDirectSendCapacity({ workspaceId: "w", accountId: "a" }),
    ).rejects.toMatchObject({
      errorInfo: {
        code: "rate_limited",
        phase: "admission",
        retryAfterMs: 1234,
      },
    })
    expect(evalRedis).toHaveBeenLastCalledWith(
      expect.any(String),
      1,
      "zalo-direct-rate:{w:a}:account",
      60_000,
      60,
    )
  })
  it("retains atomic 60/account and 10/group capacities", async () => {
    evalRedis.mockResolvedValue(0)
    await takeGroupSendCapacity({
      workspaceId: "w",
      accountId: "a",
      providerGroupId: "g",
    })
    expect(evalRedis).toHaveBeenLastCalledWith(
      expect.any(String),
      2,
      "zalo-group-rate:{w:a}:account",
      "zalo-group-rate:{w:a}:group:g",
      60_000,
      60,
      10,
    )
  })
  it("fails closed when Redis is unavailable", async () => {
    useExisting.mockRejectedValueOnce(new Error("secret"))
    await expect(
      takeDirectSendCapacity({ workspaceId: "w", accountId: "a" }),
    ).rejects.toMatchObject({
      errorInfo: { code: "admission_unavailable", phase: "admission" },
    })
  })
})
