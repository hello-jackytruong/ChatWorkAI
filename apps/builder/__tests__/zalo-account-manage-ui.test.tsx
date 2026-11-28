import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NextIntlClientProvider } from "next-intl"
import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "../messages/en.json"

const mocks = vi.hoisted(() => ({
  operations: vi.fn(),
  status: vi.fn(),
  disconnect: vi.fn(),
  refresh: vi.fn(),
  invalidateInboxes: vi.fn().mockResolvedValue(undefined),
  historyStatus: vi.fn(),
  historyStart: vi.fn(),
  historyResume: vi.fn(),
  contactCapability: vi.fn(),
  contactLookup: vi.fn(),
  contactOpen: vi.fn(),
  push: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}))
vi.mock("../src/features/inboxes/provider/inbox-hook", () => ({
  useInvalidateInboxes: () => mocks.invalidateInboxes,
}))
vi.mock(
  "../src/features/zalo-accounts/actions/account-operations.action",
  () => ({
    getZaloAccountOperationsAction: mocks.operations,
    getZaloAccountStatusAction: mocks.status,
  }),
)
vi.mock("../src/features/zalo-accounts/actions/history-sync.action", () => ({
  getZaloHistorySyncStatusAction: mocks.historyStatus,
  resumeZaloHistorySyncAction: mocks.historyResume,
  startZaloHistorySyncAction: mocks.historyStart,
}))
vi.mock(
  "../src/features/zalo-accounts/actions/contact-operations.action",
  () => ({
    getZaloContactOperationsCapabilityAction: mocks.contactCapability,
    lookupZaloContactsAction: mocks.contactLookup,
    openZaloContactConversationAction: mocks.contactOpen,
    listZaloContactsAction: vi.fn(),
    getZaloContactRequestStatusAction: vi.fn(),
    getZaloContactPresenceAction: vi.fn(),
    mutateZaloContactAction: vi.fn(),
  }),
)
vi.mock(
  "../src/features/zalo-accounts/components/zalo-account-connect",
  () => ({
    ZaloAccountConnect: ({ children }: { children: ReactNode }) => children,
  }),
)
vi.mock("../src/features/zalo-accounts/components/zalo-account-groups", () => ({
  ZaloAccountGroups: () => <div>Account group configuration</div>,
}))
vi.mock("../src/features/inboxes/components/add-channel-button", () => ({
  AddChannelButton: () => null,
}))
vi.mock(
  "../src/features/inboxes/components/inbox-mark-read-on-outbound-switch",
  () => ({
    InboxMarkReadOnOutboundSwitch: () => <span>Read setting</span>,
  }),
)
vi.mock("../src/lib/orpc/query", () => ({
  orpc: {
    connectionsAPI: {
      disconnectConnectionAPI: {
        mutationOptions: (options: object) => ({
          mutationFn: mocks.disconnect,
          ...options,
        }),
      },
    },
  },
}))

vi.mock("../src/features/realtime/use-workspace-realtime-events", () => ({
  useWorkspaceRealtimeEvents: vi.fn(),
}))

import { ZaloAccountManage } from "../src/features/zalo-accounts/components/zalo-account-manage"
import { ZaloAccountStatus } from "../src/features/zalo-accounts/components/zalo-account-status"
import { ZaloHistorySyncControls } from "../src/features/zalo-accounts/components/zalo-history-sync-controls"
import { zaloAccountOperationsKey } from "../src/features/zalo-accounts/queries/use-account-operations"
import { zaloAccountStatusKey } from "../src/features/zalo-accounts/queries/use-account-status"

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let client: QueryClient
const data = {
  status: {
    status: "connected",
    gatewayAvailable: true,
    runtime: {
      phase: "connected",
      socketOpen: true,
      freshness: "fresh",
      reconnectCount: 0,
    },
  },
  groups: [],
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.operations.mockResolvedValue({ data })
  mocks.status.mockResolvedValue({ data: data.status })
  mocks.historyStatus.mockResolvedValue({ data: { enabled: false, run: null } })
  mocks.contactCapability.mockResolvedValue({ data: { enabled: false } })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
})
function render(children: ReactNode) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages}>
          {children}
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  )
}
async function click(text: string) {
  await act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === text,
    )
    expect(button).toBeDefined()
    button?.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}

async function waitForText(container: HTMLElement, text: string) {
  await vi.waitFor(async () => {
    await act(async () => undefined)
    expect(container.textContent).toContain(text)
  })
}
it("keeps details in configuration and discards an in-flight connected result after successful disconnect", async () => {
  client.setQueryData(zaloAccountOperationsKey("w", "a"), data)
  client.setQueryData(zaloAccountStatusKey("w", "a"), data.status)
  render(
    <ZaloAccountManage
      accounts={[
        {
          id: "a",
          name: "Personal Zalo",
          inboxId: "i",
          groups: [],
          connection: { id: "c", status: "connected" },
        } as never,
      ]}
      canCreate
      workspaceId="w"
    />,
  )
  expect(host.textContent).toContain(messages.zaloAccount.active)
  expect(document.body.textContent).not.toContain("Account group configuration")
  expect(document.body.textContent).not.toContain("Read setting")
  await click(messages.zaloAccount.configure)
  expect(document.body.textContent).toContain("Account group configuration")
  expect(document.body.textContent).toContain("Read setting")
  let resolveOldStatus:
    | ((value: { data: typeof data.status }) => void)
    | undefined
  mocks.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOldStatus = resolve
      }),
  )
  act(() => {
    client
      .refetchQueries({ queryKey: zaloAccountStatusKey("w", "a") })
      .catch(() => undefined)
  })
  expect(resolveOldStatus).toBeDefined()
  mocks.disconnect.mockImplementation(() => {
    mocks.status.mockReturnValue(new Promise(() => undefined))
    mocks.operations.mockReturnValue(
      new Promise(() => {
        // Keep the refetch pending to verify the mutation updates cached status immediately.
      }),
    )
    return Promise.resolve({
      status: "disconnected",
      statusReason: "user_disconnected",
    })
  })
  await click(messages.actions.disconnect)
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (item) => item.textContent === messages.actions.disconnect,
  )
  await act(async () => {
    buttons.at(-1)?.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  expect(mocks.disconnect).toHaveBeenCalledWith(
    { workspaceId: "w", id: "c" },
    expect.anything(),
  )
  await act(async () => {
    resolveOldStatus?.({ data: data.status })
    await new Promise((resolve) => setTimeout(resolve, 1))
  })
  expect(client.getQueryData(zaloAccountStatusKey("w", "a"))).toMatchObject({
    status: "disconnected",
    gatewayAvailable: false,
    runtime: { socketOpen: false },
  })
  expect(host.textContent).toContain(messages.zaloAccount.disconnected)
  expect(host.textContent).not.toContain(messages.zaloAccount.active)
  expect(mocks.invalidateInboxes).toHaveBeenCalled()
})
it.each([
  ["connected", true, false, messages.zaloAccount.active],
  ["connected", false, false, messages.zaloAccount.degraded],
  ["degraded", true, false, messages.zaloAccount.degraded],
  ["needs_reauth", false, false, messages.zaloAccount.reconnectRequired],
  ["disconnected", false, false, messages.zaloAccount.disconnected],
  ["paused", false, false, messages.zaloAccount.paused],
  ["connected", true, true, messages.zaloAccount.statusUnavailable],
] as const)("renders status %s (gateway %s, unavailable %s)", (status, gatewayAvailable, unavailable, label) => {
  render(
    <ZaloAccountStatus
      gatewayAvailable={gatewayAvailable}
      socketOpen={true}
      status={status}
      unavailable={unavailable}
    />,
  )
  expect(host.textContent).toBe(label)
})

it("does not label a lease-only account active without verified socket state", () => {
  render(<ZaloAccountStatus gatewayAvailable status="connected" />)
  expect(host.textContent).not.toBe(messages.zaloAccount.active)
})

it("shows the latest checkpoint in account configuration and resumes only on request", async () => {
  const run = {
    runId: "run-1",
    status: "partial",
    pages: 2,
    messages: 41,
    mediaQueued: 3,
    skipped: 1,
    canResume: true,
  }
  mocks.historyStatus.mockResolvedValue({ data: { enabled: true, run } })
  mocks.historyResume.mockResolvedValue({
    data: { ...run, status: "complete", canResume: false },
  })
  render(
    <ZaloAccountManage
      accounts={[
        {
          id: "a",
          name: "Personal Zalo",
          inboxId: "i",
          groups: [],
          connection: { id: "c", status: "connected" },
        } as never,
      ]}
      canCreate
      workspaceId="w"
    />,
  )
  expect(mocks.historyStatus).not.toHaveBeenCalled()
  await click(messages.zaloAccount.configure)
  expect(mocks.historyStatus).toHaveBeenCalledWith("w", "a", {})
  expect(document.body.textContent).toContain("History sync")
  await waitForText(document.body, "More history may be available")
  expect(document.body.textContent).toContain("41")
  expect(mocks.historyResume).not.toHaveBeenCalled()
  await click("Continue sync")
  expect(mocks.historyResume).toHaveBeenCalledWith("w", "a", {
    runId: "run-1",
    commandId: expect.any(String),
  })
  await waitForText(document.body, "Zalo has no more history for this sync")
})

it("keeps conversation requests and retries in the selected history scope", async () => {
  const target = { conversationId: "7", contactInboxId: "8" }
  const run = {
    runId: "9",
    status: "failed",
    pages: 1,
    messages: 4,
    mediaQueued: 0,
    skipped: 2,
    canResume: true,
    error: "provider-internal-log",
  }
  mocks.historyStatus.mockResolvedValue({ data: { enabled: true, run } })
  mocks.historyResume
    .mockResolvedValueOnce({ serverError: "provider-internal-log" })
    .mockResolvedValueOnce({
      data: { ...run, status: "complete", canResume: false },
    })
  render(<ZaloHistorySyncControls accountId="a" workspaceId="w" {...target} />)
  await waitForText(host, "Sync stopped before finishing")
  expect(mocks.historyStatus).toHaveBeenCalledWith("w", "a", target)
  expect(host.textContent).toContain(
    "Sync available history for this conversation.",
  )
  await click("Retry sync")
  const firstInput = mocks.historyResume.mock.calls[0]?.[2]
  expect(firstInput).toEqual({
    ...target,
    runId: "9",
    commandId: expect.any(String),
  })
  await waitForText(host, "Could not sync the next page. Try again.")
  expect(host.textContent).not.toContain("provider-internal-log")
  await click("Retry sync")
  expect(mocks.historyResume).toHaveBeenLastCalledWith("w", "a", firstInput)
  expect(mocks.historyStart).not.toHaveBeenCalled()
  await waitForText(host, "Zalo has no more history for this sync")
})

it("opens a verified Zalo conversation only after deliberate lookup and result selection", async () => {
  mocks.contactCapability.mockResolvedValue({ data: { enabled: true } })
  mocks.contactLookup.mockResolvedValue({
    data: {
      contacts: [
        {
          uid: "uid-2",
          name: "Tran Linh",
          selectionToken: "verified-selection",
        },
      ],
    },
  })
  mocks.contactOpen.mockResolvedValue({
    data: { conversationId: "12", contactInboxId: "13" },
  })
  render(
    <ZaloAccountManage
      accounts={[
        {
          id: "a",
          name: "Personal Zalo",
          inboxId: "i",
          groups: [],
          connection: { id: "c", status: "connected" },
        } as never,
      ]}
      canCreate
      workspaceId="w"
    />,
  )
  await click(messages.zaloAccount.configure)
  expect(mocks.contactLookup).not.toHaveBeenCalled()
  await click("Zalo contacts")
  const search = await vi.waitFor(async () => {
    await act(async () => undefined)
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Zalo username"]',
    )
    expect(input).not.toBeNull()
    return input
  })
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set
    if (search) {
      setter?.call(search, "linh.tran")
      search.dispatchEvent(new Event("input", { bubbles: true }))
    }
  })
  expect(mocks.contactLookup).not.toHaveBeenCalled()
  await click("Search Zalo")
  expect(mocks.contactLookup).toHaveBeenCalledWith("w", "a", {
    commandId: expect.any(String),
    operation: { kind: "lookupUsername", username: "linh.tran" },
  })
  expect(mocks.contactOpen).not.toHaveBeenCalled()
  await waitForText(document.body, "Tran Linh")
  await click("Tran Linh")
  expect(mocks.contactOpen).not.toHaveBeenCalled()
  await click("Open conversation")
  expect(mocks.contactOpen).toHaveBeenCalledWith("w", "a", {
    selectionToken: "verified-selection",
  })
  expect(mocks.push).toHaveBeenCalledWith("/space/w/inbox?conversationId=12")
})
