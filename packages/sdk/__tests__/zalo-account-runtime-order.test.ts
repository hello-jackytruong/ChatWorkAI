import { expect, it } from "vitest"
import { isNewerZaloAccountRuntimeEvent } from "../src/lib/zalo-account"

it("uses attempt and observation sequence before wall clock for complete orders", () => {
  const previous = {
    fenceToken: "8",
    epoch: 1,
    socketAttempt: 2,
    sequence: 5,
    occurredAt: "2026-11-23T01:00:00.000Z",
    state: "closed" as const,
  }
  expect(
    isNewerZaloAccountRuntimeEvent(
      {
        ...previous,
        sequence: 6,
        occurredAt: "2026-11-23T00:00:00.000Z",
        state: "connected",
      },
      previous,
    ),
  ).toBe(true)
  expect(
    isNewerZaloAccountRuntimeEvent(
      {
        ...previous,
        socketAttempt: 1,
        sequence: 99,
        occurredAt: "2026-11-23T02:00:00.000Z",
      },
      previous,
    ),
  ).toBe(false)
  expect(
    isNewerZaloAccountRuntimeEvent(
      { ...previous, sequence: 4, occurredAt: "2026-11-23T02:00:00.000Z" },
      previous,
    ),
  ).toBe(false)
})

it("preserves legacy timestamp fallback for mixed orders", () => {
  const previous = {
    fenceToken: "8",
    epoch: 1,
    socketAttempt: 2,
    sequence: 5,
    occurredAt: "2026-11-23T01:00:00.000Z",
    state: "connected" as const,
  }
  expect(
    isNewerZaloAccountRuntimeEvent(
      {
        fenceToken: "8",
        epoch: 1,
        occurredAt: "2026-11-23T02:00:00.000Z",
        state: "closed",
      },
      previous,
    ),
  ).toBe(true)
})

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
