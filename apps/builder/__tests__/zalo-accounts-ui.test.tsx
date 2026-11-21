import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "../messages/en.json"

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  options: [] as Array<{ onSuccess?: () => unknown }>,
  enabled: false,
  gatewayAvailable: true,
}))
vi.mock("../src/features/zalo-accounts/queries/use-account-operations", () => ({
  useZaloAccountOperations: () => ({
    data: {
      status: {
        groupMessagingEnabled: mocks.enabled,
        status: "connected",
        gatewayAvailable: mocks.gatewayAvailable,
        friends: { count: 0, complete: false },
        groups: { count: 1, complete: true },
        labels: {
          version: 1,
          complete: false,
          paused: true,
          reason: "outcomeUnknown",
        },
      },
    },
  }),
  useInvalidateZaloAccountOperations: () => mocks.invalidate,
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: (_action: unknown, options: { onSuccess?: () => unknown }) => {
    mocks.options.push(options)
    return { execute: vi.fn(), isPending: false }
  },
}))
vi.mock(
  "../src/features/zalo-accounts/actions/account-operations.action",
  () => ({
    setZaloAccountGroupMessagingAction: vi.fn(),
    syncZaloAccountFriendsAction: vi.fn(),
  }),
)
vi.mock("../src/features/zalo-accounts/actions/sync-groups.action", () => ({
  syncZaloAccountGroupsAction: vi.fn(),
}))
vi.mock("../src/features/zalo-accounts/actions/sync-labels.action", () => ({
  syncZaloAccountLabelsAction: vi.fn(),
}))
vi.mock(
  "../src/features/zalo-accounts/actions/send-group-message.action",
  () => ({ sendZaloAccountGroupMessageAction: vi.fn() }),
)
vi.mock(
  "../src/features/zalo-accounts/actions/update-group-policy.action",
  () => ({ updateZaloAccountGroupPolicyAction: vi.fn() }),
)

import { ZaloAccountGroups } from "../src/features/zalo-accounts/components/zalo-account-groups"

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const group = {
  id: "g",
  name: "Team",
  accessible: true,
  receiveEnabled: true,
  sendEnabled: true,
  automationMode: "mentionOnly",
  memberCount: 3,
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  mocks.options = []
  mocks.enabled = false
  mocks.gatewayAvailable = true
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const render = (accessible = true) =>
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ZaloAccountGroups
          accountId="a"
          accountName="Account"
          groupMessagingEnabled={false}
          groups={[{ ...group, accessible } as never]}
          workspaceId="w"
        />
      </NextIntlClientProvider>,
    ),
  )
it("disables group controls under the account kill switch and renders safe label recovery copy", () => {
  render()
  expect(
    host.querySelector('[aria-label="Receive"]')?.getAttribute("aria-disabled"),
  ).toBe("true")
  expect(
    host.querySelector('[aria-label="Send"]')?.getAttribute("aria-disabled"),
  ).toBe("true")
  expect(host.textContent).toContain("Label update outcome unknown")
  expect(host.textContent).not.toContain("outcomeUnknown")
})
it("keeps inaccessible groups disabled and invalidates after policy changes", async () => {
  mocks.enabled = true
  render(false)
  expect(
    host.querySelector('[aria-label="Send"]')?.getAttribute("aria-disabled"),
  ).toBe("true")
  await mocks.options[4]?.onSuccess?.()
  expect(mocks.invalidate).toHaveBeenCalled()
})
it("blocks settings sends while the gateway is unavailable", () => {
  mocks.enabled = true
  mocks.gatewayAvailable = false
  render()
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Message"]')
      ?.disabled,
  ).toBe(true)
})
