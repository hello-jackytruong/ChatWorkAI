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
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
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
