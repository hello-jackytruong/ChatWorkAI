// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import en from "../messages/en.json"
import { ZaloAccountContacts } from "../src/features/zalo-accounts/components/zalo-account-contacts"

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  list: vi.fn(),
  presence: vi.fn(),
  mutate: vi.fn(),
  requestStatus: vi.fn(),
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("@/features/zalo-accounts/actions/contact-operations.action", () => ({
  getZaloContactOperationsCapabilityAction: mocks.capability,
  listZaloContactsAction: mocks.list,
  getZaloContactPresenceAction: mocks.presence,
  mutateZaloContactAction: mocks.mutate,
  getZaloContactRequestStatusAction: mocks.requestStatus,
  lookupZaloContactsAction: vi.fn(),
  openZaloContactConversationAction: vi.fn(),
}))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let client: QueryClient

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.resetAllMocks()
  mocks.capability.mockResolvedValue({ data: { enabled: true } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
          <ZaloAccountContacts accountId="2" workspaceId="1" />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  )
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
})

function button(label: string) {
  return Array.from(host.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  )
}

async function click(label: string) {
  await vi.waitFor(async () => {
    await act(async () => undefined)
    expect(button(label)).toBeDefined()
    expect(button(label)?.disabled).toBe(false)
  })
  await act(async () => button(label)?.click())
}

it("keeps absent bulk contacts unknown and honors hidden presence without exposing timestamps", async () => {
  mocks.list.mockResolvedValue({
    data: {
      complete: true,
      contacts: [
        { uid: "friend-a", name: "Linh", selectionToken: "token-a" },
        { uid: "friend-b", name: "Thu", selectionToken: "token-b" },
      ],
    },
  })
  mocks.presence.mockResolvedValue({
    data: {
      presence: [
        { uid: "friend-a", status: "hidden", lastOnlineMs: 1_700_000_000_000 },
      ],
    },
  })
  await click("Zalo contacts")
  await click("Close friends")
  expect(mocks.presence).not.toHaveBeenCalled()
  await click("Check list presence")
  expect(mocks.presence).toHaveBeenCalledOnce()
  expect(mocks.presence).toHaveBeenCalledWith("1", "2", {
    kind: "onlines",
    uids: ["friend-a", "friend-b"],
    commandId: expect.any(String),
  })
  expect(host.textContent).toContain("LinhPresence hidden")
  expect(host.textContent).toContain("ThuPresence unknown")
  expect(host.textContent).not.toContain("Offline")
  expect(host.textContent).not.toContain("Last online")
})

it("requires confirmation before accepting a request and disables repeat mutation after an unknown result", async () => {
  mocks.list.mockResolvedValue({
    data: {
      complete: false,
      contacts: [
        {
          uid: "received",
          name: "Linh",
          request: "incoming",
          selectionToken: "verified-token",
        },
      ],
    },
  })
  mocks.mutate.mockResolvedValue({ data: { status: "unknown" } })
  await click("Zalo contacts")
  await click("Received requests")
  expect(host.textContent).toContain(
    "Zalo may have more results than this list shows.",
  )
  await click("Linh")
  await click("Accept request")
  expect(mocks.mutate).not.toHaveBeenCalled()
  await click("Confirm")
  expect(mocks.mutate).toHaveBeenCalledOnce()
  expect(mocks.mutate).toHaveBeenCalledWith("1", "2", {
    operation: { kind: "accept", uid: "received" },
    selectionToken: "verified-token",
    commandId: expect.any(String),
  })
  expect(host.textContent).toContain("The result is unknown.")
  expect(button("Accept request")).toBeUndefined()
  expect(button("Check friendship")).toBeDefined()
})
