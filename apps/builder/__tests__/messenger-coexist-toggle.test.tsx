import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  invalidate: vi.fn(),
  error: vi.fn(),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/lib/orpc/orpc", () => ({
  client: { integrationMessengerAPIs: { setCoexistMessengerAPI: mocks.set } },
}))
vi.mock("@/features/inboxes/provider/inbox-hook", () => ({
  useInvalidateInboxes: () => mocks.invalidate,
}))
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: vi.fn() } }))

import { MessengerCoexistToggle } from "@/features/integration-messenger/components/messenger-coexist-toggle"

let container: HTMLDivElement
let root: Root
Object.assign(globalThis, {
  ResizeObserver: class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  },
})
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  mocks.set.mockResolvedValue({ success: true, runId: "run" })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
async function startResync(skipNamelessContacts: boolean) {
  act(() => {
    root.render(
      <MessengerCoexistToggle
        initialAiReadsSyncedHistory
        initialEnabled={false}
        integrationId="page"
        skipNamelessContacts={skipNamelessContacts}
        workspaceId="ws"
      />,
    )
  })
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) =>
        button.textContent?.includes("coexist.resyncHistoryLabel"),
      )
      ?.click()
    await Promise.resolve()
  })
}

test("full resync sends the current skip preference and preserves the AI preference", async () => {
  await startResync(false)
  expect(mocks.invalidate).toHaveBeenCalled()
  expect(mocks.set).toHaveBeenCalledWith({
    workspaceId: "ws",
    integrationId: "page",
    enabled: true,
    aiReadsSyncedHistory: true,
    skipNamelessContacts: false,
    resyncHistory: true,
  })
  expect(
    container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
  ).toBe("true")
})

test("a refused sync reports the error and does not pretend it enabled", async () => {
  mocks.set.mockResolvedValue({
    success: false,
    reason: "contact_import_running",
  })
  await startResync(true)
  expect(mocks.error).toHaveBeenCalledWith(
    "coexist.errors.contactImportRunning",
  )
  expect(
    container.querySelector('[role="switch"]')?.getAttribute("aria-checked"),
  ).toBe("false")
  expect(mocks.invalidate).not.toHaveBeenCalled()
})
