import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: unknown) => void>,
}))
vi.mock("@/features/realtime/use-workspace-realtime-events", () => ({
  useWorkspaceRealtimeEvents: (
    handlers: Record<string, (event: unknown) => void>,
  ) => {
    state.handlers = handlers
  },
}))
vi.mock("@/hooks/routing", () => ({ useWorkspaceId: () => "w" }))
vi.mock("next-intl", () => ({
  useTranslations: () => (_key: string, values?: Record<string, string>) =>
    `${values?.name ?? ""} typing`,
}))

import { ZaloGroupTypingIndicator } from "../src/features/zalo-accounts/components/zalo-group-typing"

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement("div")
  root = createRoot(host)
  act(() => root.render(<ZaloGroupTypingIndicator conversationId="c1" />))
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})
it("filters other conversations and expires actor typing without a stop event", () => {
  act(() =>
    state.handlers.typing?.({
      data: {
        conversationId: "other",
        audience: "zaloAccountGroup",
        typing: true,
        seconds: 5,
        actor: { uid: "u1", name: "Other" },
      },
    }),
  )
  expect(host.textContent).toBe("")
  act(() =>
    state.handlers.typing?.({
      data: {
        conversationId: "c1",
        audience: "zaloAccountGroup",
        typing: true,
        seconds: 5,
        actor: { uid: "u1", name: "Alice" },
      },
    }),
  )
  expect(host.textContent).toContain("Alice")
  act(() => vi.advanceTimersByTime(5001))
  expect(host.textContent).toBe("")
})

it("clears actor timers when the active conversation changes", () => {
  act(() =>
    state.handlers.typing?.({
      data: {
        conversationId: "c1",
        audience: "zaloAccountGroup",
        typing: true,
        seconds: 5,
        actor: { uid: "u1", name: "Alice" },
      },
    }),
  )
  expect(host.textContent).toContain("Alice")
  act(() => root.render(<ZaloGroupTypingIndicator conversationId="c2" />))
  expect(host.textContent).toBe("")
  expect(vi.getTimerCount()).toBe(0)
})

it("uses a known contact name for legacy direct typing and rejects group or actorless group evidence", () => {
  act(() =>
    root.render(
      <ZaloGroupTypingIndicator
        contactName="Linh"
        conversationId="c1"
        threadType="user"
      />,
    ),
  )
  act(() =>
    state.handlers.typing?.({
      data: {
        conversationId: "c1",
        audience: "zaloAccountGroup",
        typing: true,
        seconds: 5,
        actor: { uid: "u1", name: "Wrong" },
      },
    }),
  )
  expect(host.textContent).toBe("")
  act(() =>
    state.handlers.typing?.({
      data: {
        conversationId: "c1",
        typing: true,
        seconds: 5,
      },
    }),
  )
  expect(host.textContent).toContain("Linh")
  act(() => vi.advanceTimersByTime(5001))
  expect(host.textContent).toBe("")
})
