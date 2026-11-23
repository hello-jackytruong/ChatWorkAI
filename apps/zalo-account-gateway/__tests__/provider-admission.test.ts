import { describe, expect, it } from "vitest"
import { ZaloAccountProviderAdmission } from "../src/transport/provider-admission"

describe("ZaloAccountProviderAdmission", () => {
  it("opens an account circuit without pausing unrelated accounts", () => {
    let now = 1000
    const admission = new ZaloAccountProviderAdmission({
      accountCooldownMs: 10_000,
      accountFailureThreshold: 2,
      now: () => now,
      providerFailureThreshold: 10,
    })

    admission.recordFailure("account-1")
    admission.recordFailure("account-1")

    expect(admission.check("account-1")).toBe(10_000)
    expect(admission.check("account-2")).toBe(0)
    now += 10_001
    expect(admission.check("account-1")).toBe(0)
  })

  it("pauses all accounts during a provider-wide failure burst and heals on success", () => {
    const admission = new ZaloAccountProviderAdmission({
      accountFailureThreshold: 10,
      providerCooldownMs: 20_000,
      providerFailureThreshold: 3,
    })

    admission.recordFailure("account-1")
    admission.recordFailure("account-2")
    admission.recordFailure("account-3")

    expect(admission.check("account-4")).toBeGreaterThan(0)
    admission.recordSuccess("account-4")
    expect(admission.check("account-1")).toBe(0)
  })
})

it("bounds account circuit memory and expires entries on access", () => {
  let now = 1000
  const admission = new ZaloAccountProviderAdmission({
    now: () => now,
    providerFailureThreshold: 100_000,
  })
  for (let i = 0; i < 5000; i++) {
    admission.recordFailure(`account-${i}`)
  }
  expect(
    (admission as unknown as { accounts: Map<string, unknown> }).accounts.size,
  ).toBeLessThanOrEqual(4096)
  expect(admission.check("new-account")).toBeGreaterThan(0)
  now += 120_001
  expect(admission.check("account-1")).toBe(0)
})
