"use client"

import {
  createZaloAccountGroupManagementCommandId,
  groupManagementRequiresConfirmation,
  type ZaloAccountGroupManagementOperation as Operation,
  type ZaloAccountGroupManagementResult as Result,
  zaloAccountGroupManagementCommandIdSchema,
  zaloAccountGroupManagementOperationSchema,
} from "@chatbotx.io/sdk"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@chatbotx.io/ui/components/ui/alert-dialog"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@chatbotx.io/ui/components/ui/tabs"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useRef, useState, useTransition } from "react"
import { useForm } from "react-hook-form"
import { MediaLibraryTrigger } from "@/features/media-library/components/media-library-trigger"
import {
  getZaloGroupManagementAttemptAction,
  getZaloGroupManagementCapabilityAction,
  mutateZaloGroupManagementAction,
} from "../actions/group-management.action"
import {
  accountOperations,
  type FormOperationKind,
  type GroupManagementMember,
  type GroupManagementTarget,
  groupOperations,
  groupRoleAllows,
  memberOperations,
  operationLabels,
  readOperations,
  type SubmitGroupOperation as Submit,
  scopeInput,
  scopeKey,
} from "../lib/group-management-ui"
import {
  GroupLinkSettings,
  LinkPreview,
  ManagementList,
  ResultMessage,
} from "./zalo-group-management-reads"

type Confirmation = {
  operation: Operation
  groupName: string
  targetName?: string
  returnFocus: HTMLElement | null
}
const memberIdSeparators = /[\s,]+/
type AttemptResponse = NonNullable<
  NonNullable<
    Awaited<ReturnType<typeof getZaloGroupManagementAttemptAction>>
  >["data"]
>
type DisplayAttempt = {
  commandId: string
  operation: Operation["kind"]
  status: AttemptResponse["status"]
  result?: Result
}

function ReviewOperation({
  review,
  onCancel,
  onConfirm,
}: {
  review: Confirmation
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useTranslations("zaloAccount.groupManagement")
  const actions = useTranslations("actions")
  const focus = useRef(review.returnFocus)
  const copy = {
    changeGroupOwner: {
      title: "confirm.transfer",
      action: "confirm.confirmTransfer",
      effect: "confirm.transferEffect",
    },
    joinGroupLink: {
      title: "confirm.join",
      action: "confirm.confirmJoin",
      effect: "confirm.joinEffect",
    },
    joinGroupInviteBox: {
      title: "confirm.join",
      action: "confirm.confirmJoin",
      effect: "confirm.joinEffect",
    },
    leaveGroup: {
      title: "confirm.leave",
      action: "confirm.confirmLeave",
      effect: "confirm.leaveEffect",
    },
    disperseGroup: {
      title: "confirm.disperse",
      action: "confirm.confirmDisperse",
      effect: "confirm.disperseEffect",
    },
    upgradeGroupToCommunity: {
      title: "confirm.upgrade",
      action: "confirm.confirmUpgrade",
      effect: "confirm.upgradeEffect",
    },
  } as const
  const kind = review.operation.kind
  if (!(kind in copy)) {
    return null
  }
  const labels = copy[kind as keyof typeof copy]
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
      open
    >
      <AlertDialogContent finalFocus={focus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(labels.title, {
              group: review.groupName,
              member: review.targetName ?? "",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t(labels.effect)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{actions("cancel")}</AlertDialogCancel>
          <Button onClick={onConfirm} type="button" variant="destructive">
            {t(labels.action)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

type OperationFormValues = { name: string; members: string; uid: string }

function OperationForm({
  kind,
  member,
  scope,
  submit,
}: {
  kind: FormOperationKind
  member?: GroupManagementMember
  scope: GroupManagementTarget
  submit: Submit
}) {
  const t = useTranslations("zaloAccount.groupManagement")
  const fields = useTranslations("fields")
  const actions = useTranslations("actions")
  const form = useForm<OperationFormValues>({
    defaultValues: { name: "", members: "", uid: "" },
  })
  const [avatar, setAvatar] =
    useState<Extract<Operation, { kind: "changeGroupAvatar" }>["avatar"]>()
  const [invalid, setInvalid] = useState(false)
  const needsName = kind === "createGroup" || kind === "changeGroupName"
  const needsMembers = kind === "createGroup" || kind === "addUserToGroup"
  const needsUid = kind === "inviteUserToGroups"
  const buttonText =
    kind === "changeGroupOwner" ? t("reviewTransfer") : actions("continue")

  function save(values: OperationFormValues) {
    const parsed = zaloAccountGroupManagementOperationSchema.safeParse({
      kind,
      ...(needsName ? { name: values.name } : {}),
      ...(needsMembers
        ? {
            memberUids: values.members
              .split(memberIdSeparators)
              .filter(Boolean),
          }
        : {}),
      ...(needsUid ? { uid: values.uid.trim() } : {}),
      ...(kind === "changeGroupAvatar" ? { avatar } : {}),
      ...(member && kind === "changeGroupOwner" ? { uid: member.uid } : {}),
      ...(member &&
      (kind === "removeUserFromGroup" ||
        kind === "addGroupBlockedMember" ||
        kind === "addGroupDeputy" ||
        kind === "removeGroupDeputy")
        ? { memberUids: [member.uid] }
        : {}),
    })
    setInvalid(!parsed.success)
    if (parsed.success) {
      submit(parsed.data, member?.name)
    }
  }

  return (
    <Form {...form}>
      <form className="space-y-3" onSubmit={form.handleSubmit(save)}>
        {needsName && (
          <InputField<OperationFormValues>
            label={fields("name.label")}
            maxLength={100}
            name="name"
            required
          />
        )}
        {needsMembers && (
          <TextareaField<OperationFormValues>
            description={t("memberIdsHint")}
            label={t("memberIds")}
            name="members"
            required
          />
        )}
        {needsUid && (
          <InputField<OperationFormValues>
            inputMode="numeric"
            label={t("memberId")}
            maxLength={200}
            name="uid"
            required
          />
        )}
        {kind === "changeGroupAvatar" && (
          <div className="flex flex-wrap items-center gap-2">
            <MediaLibraryTrigger
              fileType="image"
              onSelect={(file) => {
                const parsed =
                  zaloAccountGroupManagementOperationSchema.safeParse({
                    kind,
                    avatar: {
                      kind: "image",
                      url: file.url,
                      name: file.name,
                      mimeType: file.mimeType,
                      size: file.size,
                    },
                  })
                if (
                  !(
                    parsed.success &&
                    parsed.data.kind === kind &&
                    file.mimeType.startsWith("image/")
                  )
                ) {
                  setAvatar(undefined)
                  setInvalid(true)
                  return
                }
                setInvalid(false)
                setAvatar(parsed.data.avatar)
              }}
              workspaceId={scope.workspaceId}
            />
            {avatar?.name && (
              <span className="wrap-break-word">{avatar.name}</span>
            )}
          </div>
        )}
        {member && (
          <p>
            {member.name} · {member.uid}
          </p>
        )}
        {invalid && <p role="alert">{t("invalid")}</p>}
        <Button
          disabled={kind === "changeGroupAvatar" && !avatar}
          size="sm"
          type="submit"
        >
          {buttonText}
        </Button>
      </form>
    </Form>
  )
}

export function ZaloGroupManagementControls({
  member,
  onChanged,
  onClearMember,
  ...scope
}: GroupManagementTarget & {
  member?: GroupManagementMember
  onChanged?: () => void | Promise<void>
  onClearMember?: () => void
}) {
  const t = useTranslations("zaloAccount.groupManagement")
  const actions = useTranslations("actions")
  const client = useQueryClient()
  const [option, setOption] = useState<FormOperationKind>()
  const [review, setReview] = useState<Confirmation>()
  const [attempt, setAttempt] = useState<DisplayAttempt>()
  const [pending, startTransition] = useTransition()
  const [inspectPending, startInspect] = useTransition()
  const running = useRef(false)
  const inspecting = useRef(false)
  const [inspectFailed, setInspectFailed] = useState(false)
  const [previousCommand, setPreviousCommand] = useState("")
  const selector = useRef<HTMLSelectElement>(null)
  const capability = useQuery({
    queryKey: [
      "zalo-group-management-capability",
      scope.workspaceId,
      scope.accountId,
    ],
    queryFn: async ({ signal }) => {
      const response = await getZaloGroupManagementCapabilityAction(
        scope.workspaceId,
        scope.accountId,
      )
      signal.throwIfAborted()
      if (!response?.data) {
        throw new Error("Unable to read Zalo group management availability")
      }
      return response.data
    },
    gcTime: 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })

  const role = scope.group?.role
  const canWrite = capability.data?.enabled === true
  const scopeOperations = scope.group ? groupOperations : accountOperations
  const options = (member ? memberOperations(member) : scopeOperations).filter(
    (kind) => groupRoleAllows(role, kind),
  )
  const needsInspection =
    attempt?.status === "pending" ||
    attempt?.status === "dispatched" ||
    attempt?.status === "unknown"

  async function changed() {
    await client.invalidateQueries({ queryKey: [...scopeKey(scope), "read"] })
    await onChanged?.()
  }

  function dispatch(operation: Operation, confirmed?: true) {
    if (!canWrite || running.current || attempt) {
      return
    }
    const commandId = createZaloAccountGroupManagementCommandId()
    running.current = true
    setReview(undefined)
    startTransition(async () => {
      try {
        const response = await mutateZaloGroupManagementAction(
          scope.workspaceId,
          scope.accountId,
          {
            ...scopeInput(scope),
            operation,
            commandId,
            ...(confirmed ? { confirmed } : {}),
          },
        )
        const record = response?.data ?? {
          commandId,
          operation: operation.kind,
          status: "unknown" as const,
        }
        setAttempt(record)
        if (record.status === "confirmed" || record.status === "partial") {
          await changed()
        }
      } catch {
        setAttempt(
          (current) =>
            current ?? {
              commandId,
              operation: operation.kind,
              status: "unknown",
            },
        )
      } finally {
        running.current = false
      }
    })
  }

  function submit(operation: Operation, targetName?: string) {
    if (!groupRoleAllows(role, operation.kind)) {
      return
    }
    if (groupManagementRequiresConfirmation(operation)) {
      setReview({
        operation,
        groupName: scope.group?.name ?? targetName ?? "",
        targetName,
        returnFocus:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : selector.current,
      })
    } else {
      dispatch(operation)
    }
  }

  function inspect(commandId: string) {
    if (inspecting.current) {
      return
    }
    const parsed = zaloAccountGroupManagementCommandIdSchema.safeParse(
      commandId.trim(),
    )
    setInspectFailed(!parsed.success)
    if (!parsed.success) {
      return
    }
    inspecting.current = true
    startInspect(async () => {
      try {
        const response = await getZaloGroupManagementAttemptAction(
          scope.workspaceId,
          scope.accountId,
          { ...scopeInput(scope), commandId: parsed.data },
        )
        if (response?.data) {
          setAttempt(response.data)
          if (
            response.data.status === "confirmed" ||
            response.data.status === "partial"
          ) {
            await changed()
          }
        } else {
          setInspectFailed(true)
        }
      } catch {
        setInspectFailed(true)
      } finally {
        inspecting.current = false
      }
    })
  }

  if (attempt) {
    const result: Result = attempt.result ?? {
      kind: attempt.operation,
      outcome:
        attempt.status === "pending" || attempt.status === "dispatched"
          ? "pending"
          : "unknown",
    }
    return (
      <div className="space-y-2">
        <ResultMessage
          providerPending={attempt.status === "provider_pending"}
          result={result}
        />
        {needsInspection ? (
          <>
            <code className="wrap-break-word text-xs">{attempt.commandId}</code>
            <div>
              <Button
                disabled={inspectPending}
                onClick={() => inspect(attempt.commandId)}
                size="sm"
                type="button"
                variant="secondary"
              >
                {t("inspect")}
              </Button>
            </div>
            {inspectFailed && <p role="status">{t("attemptUnavailable")}</p>}
          </>
        ) : (
          <Button
            onClick={() => {
              setAttempt(undefined)
              setOption(undefined)
              setPreviousCommand("")
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("nextOperation")}
          </Button>
        )}
      </div>
    )
  }

  const operationPanel = (
    <div className="space-y-3">
      {capability.isPending && <p role="status">{actions("loading")}</p>}
      {capability.isError && (
        <Button
          onClick={() => capability.refetch()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {actions("retry")}
        </Button>
      )}
      {capability.data && !canWrite && (
        <p role="status">{t("writesUnavailable")}</p>
      )}
      {member && onClearMember && (
        <Button
          onClick={onClearMember}
          size="sm"
          type="button"
          variant="secondary"
        >
          {actions("back")}
        </Button>
      )}
      <select
        aria-label={t("operation")}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-ring disabled:opacity-50"
        disabled={pending || capability.isPending}
        onChange={(event) => {
          setOption(options.find((kind) => kind === event.target.value))
        }}
        ref={selector}
        value={option ?? ""}
      >
        <option disabled value="">
          {t("operation")}
        </option>
        {options.map((kind) => (
          <option
            disabled={!(canWrite || readOperations.has(kind))}
            key={kind}
            value={kind}
          >
            {t(operationLabels[kind])}
          </option>
        ))}
      </select>
      {pending && <p role="status">{actions("loading")}</p>}
      {option && !pending && (
        <>
          {option === "getGroupLinkInfo" && (
            <LinkPreview canWrite={canWrite} scope={scope} submit={submit} />
          )}
          {option === "getGroupInviteBoxList" && (
            <ManagementList
              canWrite={canWrite}
              kind={option}
              scope={scope}
              submit={submit}
            />
          )}
          {option === "getGroupLinkDetail" && (
            <GroupLinkSettings
              canWrite={canWrite}
              scope={scope}
              submit={submit}
            />
          )}
          {(option === "updateGroupSettings" ||
            option === "upgradeGroupToCommunity") && (
            <p role="status">{t("verificationRequired")}</p>
          )}
          {canWrite &&
            !readOperations.has(option) &&
            option !== "updateGroupSettings" &&
            option !== "upgradeGroupToCommunity" && (
              <OperationForm
                key={option}
                kind={option}
                member={member}
                scope={scope}
                submit={submit}
              />
            )}
        </>
      )}
      {!pending && (
        <details>
          <summary className="w-fit cursor-pointer">
            {t("inspectPrevious")}
          </summary>
          <form
            className="mt-2 space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              inspect(previousCommand)
            }}
          >
            <Input
              aria-label={t("commandId")}
              maxLength={50}
              onChange={(event) => {
                setPreviousCommand(event.target.value)
                setInspectFailed(false)
              }}
              required
              value={previousCommand}
            />
            <Button
              disabled={inspectPending}
              size="sm"
              type="submit"
              variant="secondary"
            >
              {t("inspect")}
            </Button>
            {inspectFailed && <p role="status">{t("attemptUnavailable")}</p>}
          </form>
        </details>
      )}
    </div>
  )

  return (
    <section className="space-y-3 text-sm">
      {scope.group &&
      !member &&
      groupRoleAllows(role, "getPendingGroupMembers") ? (
        <Tabs defaultValue="operations">
          <TabsList
            aria-label={t("label")}
            className="max-w-full overflow-x-auto px-3"
          >
            <TabsTrigger className="py-2" value="operations">
              {t("operationsTab")}
            </TabsTrigger>
            <TabsTrigger className="py-2" value="pending">
              {t("pendingTab")}
            </TabsTrigger>
            <TabsTrigger className="py-2" value="blocked">
              {t("blockedTab")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="operations">{operationPanel}</TabsContent>
          <TabsContent value="pending">
            {!pending && (
              <ManagementList
                canWrite={canWrite}
                kind="getPendingGroupMembers"
                scope={scope}
                submit={submit}
              />
            )}
          </TabsContent>
          <TabsContent value="blocked">
            {!pending && (
              <ManagementList
                canWrite={canWrite}
                kind="getGroupBlockedMember"
                scope={scope}
                submit={submit}
              />
            )}
          </TabsContent>
        </Tabs>
      ) : (
        operationPanel
      )}
      {review && (
        <ReviewOperation
          onCancel={() => setReview(undefined)}
          onConfirm={() => dispatch(review.operation, true)}
          review={review}
        />
      )}
    </section>
  )
}
