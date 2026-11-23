import { afterEach, expect, it, vi } from "vitest"

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock("@chatbotx.io/logger", () => ({ getChildLogger: () => ({ warn }) }))

import { recordMessageDiagnostic } from "../src/runtime/message-diagnostics"

afterEach(() => vi.useRealTimers())
it("aggregates arbitrary failure floods into fixed safe counters at most once per minute", () => {
  vi.useFakeTimers()
  for (let i = 0; i < 10_000; i++) {
    recordMessageDiagnostic(`https://secret.test/${i}`)
  }
  expect(warn).not.toHaveBeenCalled()
  vi.advanceTimersByTime(60_001)
  recordMessageDiagnostic("saturation")
  expect(warn).toHaveBeenCalledOnce()
  expect(warn.mock.calls[0][0]).toEqual({
    counts: { invalid_fields: 10_000, saturation: 1 },
  })
  expect(JSON.stringify(warn.mock.calls[0])).not.toContain("secret")
  expect(Buffer.byteLength(JSON.stringify(warn.mock.calls[0]))).toBeLessThan(
    2048,
  )
  for (let i = 0; i < 10_000; i++) {
    recordMessageDiagnostic("publish_failed")
  }
  expect(warn).toHaveBeenCalledOnce()
})
