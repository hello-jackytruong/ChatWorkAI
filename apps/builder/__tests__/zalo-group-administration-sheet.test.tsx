import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "../messages/en.json"
import { ZaloAccountGroups } from "../src/features/zalo-accounts/components/zalo-account-groups"
import type { ZaloAccountGroupResource } from "../src/features/zalo-accounts/schema/resource"

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  members: vi.fn(),
  related: vi.fn(),
  managementCapability: vi.fn(),
  managementRead: vi.fn(),
  managementMutate: vi.fn(),
  managementAttempt: vi.fn(),
}))

vi.mock(
  "../src/features/zalo-accounts/actions/group-administration.action",
  () => ({
    getZaloGroupAdministrationAction: mocks.detail,
    listZaloGroupAdministrationMembersAction: mocks.members,
    listZaloGroupRelatedGroupsAction: mocks.related,
  }),
)
vi.mock(
  "../src/features/zalo-accounts/actions/group-management.action",
  () => ({
    getZaloGroupManagementCapabilityAction: mocks.managementCapability,
    readZaloGroupManagementAction: mocks.managementRead,
    mutateZaloGroupManagementAction: mocks.managementMutate,
    getZaloGroupManagementAttemptAction: mocks.managementAttempt,
  }),
)
vi.mock("@/features/media-library/components/media-library-trigger", () => ({
  MediaLibraryTrigger: () => null,
}))
vi.mock(
  "../src/features/zalo-accounts/actions/account-operations.action",
  () => ({
    setZaloAccountGroupMessagingAction: vi.fn(),
    syncZaloAccountFriendsAction: vi.fn(),
  }),
)
vi.mock(
  "../src/features/zalo-accounts/actions/send-group-message.action",
  () => ({
    sendZaloAccountGroupMessageAction: vi.fn(),
  }),
)
vi.mock("../src/features/zalo-accounts/actions/sync-groups.action", () => ({
  syncZaloAccountGroupsAction: vi.fn(),
}))
vi.mock("../src/features/zalo-accounts/actions/sync-labels.action", () => ({
  syncZaloAccountLabelsAction: vi.fn(),
}))
vi.mock(
  "../src/features/zalo-accounts/actions/update-group-policy.action",
  () => ({
    updateZaloAccountGroupPolicyAction: vi.fn(),
  }),
)
vi.mock("../src/features/zalo-accounts/queries/use-account-operations", () => ({
  useZaloAccountOperations: () => ({}),
  useInvalidateZaloAccountOperations: () => vi.fn(),
}))

const group = {
  id: "7",
  accountId: "2",
  providerGroupId: "provider-group",
  name: "Support group",
  avatarUrl: null,
  memberCount: 4,
  providerVersion: null,
  receiveEnabled: false,
  sendEnabled: false,
  automationMode: "disabled",
  contactInboxId: null,
  conversationId: null,
  accessible: true,
  lastSyncRunId: "previous-sync",
  lastSyncedAt: new Date(0),
  inaccessibleAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} satisfies ZaloAccountGroupResource

const details = {
  groupId: group.id,
  name: group.name,
  accessible: true,
  role: "deputy",
  type: "community",
  settings: {},
}
type DetailFixture = typeof details & { description?: string }
const timedCommandId = /^\d{13}:[\da-f-]{36}$/i

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
let client: QueryClient

beforeEach(() => {
  vi.resetAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.detail.mockResolvedValue({ data: details })
  mocks.managementCapability.mockResolvedValue({ data: { enabled: true } })
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
})

function render(accountId = group.accountId) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages}>
          <ZaloAccountGroups
            accountId={accountId}
            accountName="Zalo Account"
            groupMessagingEnabled={false}
            groups={[{ ...group, accountId }]}
            workspaceId="1"
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  )
}

async function click(label: string) {
  await act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (element) =>
        (element.getAttribute("aria-label") ?? element.textContent) === label,
    )
    expect(button).toBeDefined()
    button?.click()
    await Promise.resolve()
  })
}

async function waitForText(label: string) {
  await vi.waitFor(async () => {
    await act(async () => undefined)
    expect(document.body.textContent).toContain(label)
  })
}

async function selectOperation(name: string) {
  const selector = await vi.waitFor(async () => {
    await act(async () => undefined)
    const control = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Group operation"]',
    )
    expect(control?.disabled).toBe(false)
    return control
  })
  if (!selector) {
    throw new Error("Group operation selector missing")
  }
  const option = Array.from(selector.options).find(
    (entry) => entry.textContent === name,
  )
  expect(option?.disabled).toBe(false)
  await act(async () => {
    selector.value = option?.value ?? ""
    selector.dispatchEvent(new Event("change", { bubbles: true }))
    await Promise.resolve()
  })
}

function enter(label: string, value: string) {
  const labelElement = Array.from(document.querySelectorAll("label")).find(
    (element) => element.textContent?.startsWith(label),
  )
  const input =
    document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `input[aria-label="${label}"], textarea[aria-label="${label}"]`,
    ) ?? document.getElementById(labelElement?.htmlFor ?? "")
  expect(input).toBeDefined()
  if (!input) {
    throw new Error(`Field missing: ${label}`)
  }
  act(() => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

it("loads details only after opening the group and members only after choosing their tab", async () => {
  mocks.members
    .mockResolvedValueOnce({
      data: {
        members: [
          {
            uid: "account-uid",
            name: "Connected account",
            role: "deputy",
            isSelf: true,
          },
        ],
        nextCursor: "next-page",
        complete: false,
        visibility: "visible",
      },
    })
    .mockResolvedValueOnce({
      data: {
        members: [{ uid: "another-member", role: "unknown" }],
        complete: false,
        visibility: "visible",
      },
    })

  render()
  expect(mocks.detail).not.toHaveBeenCalled()
  expect(mocks.members).not.toHaveBeenCalled()
  await click("Group details: Support group")
  expect(mocks.detail).toHaveBeenCalledExactlyOnceWith("1", "2", {
    groupId: "7",
  })
  expect(mocks.members).not.toHaveBeenCalled()
  await waitForText("Community")
  expect(document.body.textContent).toContain("Deputy")
  expect(document.body.textContent).toContain("Unknown")

  await click("Members")
  expect(mocks.members).toHaveBeenCalledExactlyOnceWith("1", "2", {
    groupId: "7",
  })
  await waitForText("Connected account")
  await waitForText("Some group members could not be loaded.")
  await click("Load more")
  expect(mocks.members).toHaveBeenLastCalledWith("1", "2", {
    groupId: "7",
    cursor: "next-page",
  })
  await waitForText("another-member")
  expect(document.body.textContent).toContain("Connected account")
})

it("reads shared groups only for an explicitly selected roster member and keeps the connected account out of the lookup", async () => {
  mocks.members.mockResolvedValue({
    data: {
      members: [
        { uid: "22", name: "Our account", role: "deputy", isSelf: true },
        { uid: "33", name: "Volunteers", role: "member" },
      ],
      complete: true,
      visibility: "visible",
    },
  })
  mocks.related.mockResolvedValue({
    data: {
      groups: [{ groupId: "8", name: "Shared support forum" }],
      complete: false,
    },
  })

  render()
  await click("Group details: Support group")
  await waitForText("Community")
  await click("Members")
  await waitForText("Volunteers")
  expect(
    document.querySelector('[aria-label="Shared groups: Our account"]'),
  ).toBeNull()
  expect(mocks.related).not.toHaveBeenCalled()
  await click("Shared groups: Volunteers")
  expect(mocks.related).toHaveBeenCalledExactlyOnceWith("1", "2", {
    groupId: "7",
    uid: "33",
  })
  await waitForText("Shared support forum")
  await click("Details")
  await click("Members")
  await waitForText("Shared support forum")
  expect(mocks.related).toHaveBeenCalledTimes(1)
})

it("distinguishes restricted membership from an empty roster and retries detail errors safely", async () => {
  mocks.detail.mockResolvedValueOnce({ serverError: "provider-internal-error" })
  mocks.members.mockResolvedValue({
    data: { members: [], complete: false, visibility: "restricted" },
  })
  render()
  await click("Group details: Support group")
  await waitForText("Group details unavailable.")
  expect(document.body.textContent).not.toContain("provider-internal-error")
  expect(mocks.detail).toHaveBeenCalledTimes(1)
  await click("Retry")
  await waitForText("Community")
  await click("Members")
  await waitForText("Zalo restricts who can see this group's members.")
  expect(document.body.textContent).not.toContain("No members to display.")
  expect(mocks.members).toHaveBeenCalledTimes(1)
})

it("drops an in-flight result after switching accounts and binds detail to the newly selected account", async () => {
  let resolveOldDetail: ((value: { data: DetailFixture }) => void) | undefined
  mocks.detail.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOldDetail = resolve
      }),
  )
  render()
  await click("Group details: Support group")
  expect(resolveOldDetail).toBeDefined()
  render("3")
  expect(mocks.detail).toHaveBeenCalledTimes(1)
  mocks.detail.mockResolvedValueOnce({
    data: { ...details, description: "Current account description" },
  })
  await click("Group details: Support group")
  expect(mocks.detail).toHaveBeenLastCalledWith("1", "3", { groupId: "7" })
  await waitForText("Current account description")
  await act(async () => {
    resolveOldDetail?.({
      data: {
        ...details,
        description: "Outdated account description",
      },
    })
    await Promise.resolve()
  })
  expect(document.body.textContent).not.toContain(
    "Outdated account description",
  )
  expect(mocks.members).not.toHaveBeenCalled()
})

it("previews an invite link on demand and confirms joining the exact returned group", async () => {
  const link = "https://zalo.me/g/example"
  mocks.managementRead.mockResolvedValue({
    data: {
      kind: "getGroupLinkInfo",
      outcome: "confirmed",
      group: { providerGroupId: "987", name: "Friday volunteers" },
    },
  })
  mocks.managementMutate.mockResolvedValue({
    data: {
      operation: "joinGroupLink",
      status: "provider_pending",
      result: { kind: "joinGroupLink", outcome: "pending" },
    },
  })
  render()
  expect(mocks.managementCapability).not.toHaveBeenCalled()
  expect(mocks.managementRead).not.toHaveBeenCalled()
  await click("Group management")
  await waitForText("Group operation")
  expect(mocks.managementRead).not.toHaveBeenCalled()
  await selectOperation("Preview invite link")
  enter("Invite link", link)
  await click("Preview link")
  expect(mocks.managementRead).toHaveBeenCalledExactlyOnceWith("1", "2", {
    operation: { kind: "getGroupLinkInfo", link },
  })
  await waitForText("Friday volunteers")
  expect(mocks.managementMutate).not.toHaveBeenCalled()
  await click("Join group")
  await waitForText("Join Friday volunteers?")
  expect(mocks.managementMutate).not.toHaveBeenCalled()
  await click("Confirm join")
  expect(mocks.managementMutate).toHaveBeenCalledExactlyOnceWith("1", "2", {
    operation: { kind: "joinGroupLink", link },
    commandId: expect.any(String),
    confirmed: true,
  })
  await waitForText("Zalo accepted the request and is waiting for approval.")
  expect(mocks.managementAttempt).not.toHaveBeenCalled()
})

it("shows a partial create result with each confirmed and rejected member", async () => {
  mocks.managementMutate.mockImplementation(
    (_workspace, _account, input: { commandId: string }) =>
      Promise.resolve({
        data: {
          operation: "createGroup",
          status: "partial",
          commandId: input.commandId,
          result: {
            kind: "createGroup",
            outcome: "partial",
            memberOutcomes: [
              { uid: "22", outcome: "confirmed" },
              { uid: "33", outcome: "rejected" },
            ],
          },
        },
      }),
  )
  render()
  await click("Group management")
  await selectOperation("Create group")
  enter("Name", "Friday group")
  enter("Zalo member IDs", "22, 33")
  await click("Continue")
  await waitForText("Zalo confirmed only part of the operation.")
  expect(mocks.managementMutate).toHaveBeenCalledExactlyOnceWith("1", "2", {
    operation: {
      kind: "createGroup",
      name: "Friday group",
      memberUids: ["22", "33"],
    },
    commandId: expect.stringMatching(timedCommandId),
  })
  expect(
    Array.from(document.querySelectorAll("li"), (row) => row.textContent),
  ).toEqual(expect.arrayContaining(["22Confirmed", "33Rejected"]))
})

it("opens pending and blocked lists independently and preserves blocked-list partiality", async () => {
  mocks.managementRead.mockImplementation(
    (_workspace, _account, input: { operation: { kind: string } }) =>
      Promise.resolve({
        data:
          input.operation.kind === "getPendingGroupMembers"
            ? {
                kind: "getPendingGroupMembers",
                outcome: "confirmed",
                complete: true,
                entries: [],
              }
            : {
                kind: "getGroupBlockedMember",
                outcome: "partial",
                complete: false,
                entries: [{ id: "44", uid: "44", name: "Blocked member" }],
                nextPage: 2,
              },
      }),
  )
  render()
  await click("Group details: Support group")
  await waitForText("Community")
  expect(mocks.managementRead).not.toHaveBeenCalled()
  await click("Manage")
  await waitForText("Group operation")
  expect(mocks.managementRead).not.toHaveBeenCalled()
  await click("Pending requests")
  await waitForText("No pending requests.")
  expect(mocks.managementRead).toHaveBeenCalledExactlyOnceWith("1", "2", {
    groupId: "7",
    operation: { kind: "getPendingGroupMembers" },
  })
  await click("Blocked members")
  await waitForText("Blocked member")
  await waitForText("This list may be incomplete.")
  await click("Load more")
  expect(mocks.managementRead).toHaveBeenLastCalledWith("1", "2", {
    groupId: "7",
    operation: { kind: "getGroupBlockedMember", page: 2 },
  })
})

it("requires the selected member to be confirmed before transfer and only inspects an unknown attempt", async () => {
  mocks.detail.mockResolvedValue({ data: { ...details, role: "owner" } })
  mocks.members.mockResolvedValue({
    data: {
      members: [{ uid: "22", name: "Bao Nguyen", role: "member" }],
      complete: true,
      visibility: "visible",
    },
  })
  mocks.managementMutate.mockImplementation(
    (_workspace, _account, input: { commandId: string }) =>
      Promise.resolve({
        data: {
          operation: "changeGroupOwner",
          status: "unknown",
          commandId: input.commandId,
        },
      }),
  )
  mocks.managementAttempt.mockImplementation(
    (_workspace, _account, input: { commandId: string }) =>
      Promise.resolve({
        data: {
          operation: "changeGroupOwner",
          status: "unknown",
          commandId: input.commandId,
        },
      }),
  )
  render()
  await click("Group details: Support group")
  await waitForText("Community")
  await click("Members")
  await waitForText("Bao Nguyen")
  await click("Manage: Bao Nguyen")
  await waitForText("Group operation")
  await selectOperation("Transfer group ownership")
  await click("Review transfer")
  await waitForText("Transfer Support group to Bao Nguyen?")
  expect(mocks.managementMutate).not.toHaveBeenCalled()
  await click("Confirm transfer")
  await waitForText("Zalo has not confirmed the outcome.")
  const input = mocks.managementMutate.mock.calls[0]?.[2]
  expect(input).toEqual({
    groupId: "7",
    operation: { kind: "changeGroupOwner", uid: "22" },
    commandId: expect.any(String),
    confirmed: true,
  })
  await click("Inspect outcome")
  expect(mocks.managementAttempt).toHaveBeenCalledExactlyOnceWith("1", "2", {
    groupId: "7",
    commandId: input.commandId,
  })
  expect(mocks.managementMutate).toHaveBeenCalledTimes(1)
})
