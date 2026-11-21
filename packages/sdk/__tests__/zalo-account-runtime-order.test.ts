import { expect, it } from "vitest"
import { isNewerZaloAccountRuntimeEvent } from "../src/lib/zalo-account"

it("orders runtime state by durable fence before process-local epoch and timestamp", () => {
  const previous = {
    fenceToken: "90071992547409930",
    epoch: 9,
    occurredAt: "2026-11-21T00:00:01.000Z",
    state: "connected" as const,
  }
  expect(
    isNewerZaloAccountRuntimeEvent(
      {
        ...previous,
        fenceToken: "90071992547409929",
        epoch: 99,
        occurredAt: "2026-11-21T00:00:02.000Z",
        state: "closed",
      },
      previous,
    ),
  ).toBe(false)
  expect(
    isNewerZaloAccountRuntimeEvent(
      { ...previous, fenceToken: "90071992547409931", epoch: 1 },
      previous,
    ),
  ).toBe(true)
  expect(isNewerZaloAccountRuntimeEvent(previous, previous)).toBe(false)
  expect(
    isNewerZaloAccountRuntimeEvent({ ...previous, state: "closed" }, previous),
  ).toBe(true)
})
