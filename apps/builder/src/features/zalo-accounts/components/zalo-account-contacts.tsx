"use client"

import {
  type ZaloAccountContactMutation,
  type ZaloAccountPresence,
  zaloAccountContactOperationSchema,
} from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@chatbotx.io/ui/components/ui/collapsible"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useFormatter, useTranslations } from "next-intl"
import { type FormEvent, useEffect, useRef, useState } from "react"
import {
  getZaloContactOperationsCapabilityAction,
  getZaloContactPresenceAction,
  getZaloContactRequestStatusAction,
  listZaloContactsAction,
  lookupZaloContactsAction,
  mutateZaloContactAction,
  openZaloContactConversationAction,
} from "../actions/contact-operations.action"

const categories = [
  "incomingRequests",
  "sentRequests",
  "recommendations",
  "closeFriends",
  "aliases",
] as const
const categoryLabels = {
  incomingRequests: "incomingRequests",
  sentRequests: "sentRequests",
  recommendations: "recommendations",
  closeFriends: "closeFriends",
  aliases: "aliases",
} as const satisfies Record<(typeof categories)[number], string>
const mutationLabels = {
  accept: "accept",
  reject: "reject",
  invite: "invite",
  cancel: "cancelRequest",
  remove: "removeFriend",
  block: "block",
  unblock: "unblock",
  setAlias: "setAlias",
  clearAlias: "clearAlias",
  hideFeed: "hideFeed",
  showFeed: "showFeed",
} as const
const presenceLabels = {
  online: "online",
  offline: "offline",
  hidden: "hidden",
  unknown: "unknownPresence",
} as const
const noticeLabels = {
  invalidLookup: "invalidLookup",
  failed: "failed",
  applied: "applied",
  unknownOutcome: "unknownOutcome",
} as const
const PRESENCE_TTL_MS = 15_000

type Contact = {
  uid: string
  name?: string
  alias?: string
  request?: "incoming" | "outgoing"
  selectionToken: string
}
type Relationship = { isFriend?: boolean; sent?: boolean; received?: boolean }
type MutationKind = keyof typeof mutationLabels
type Account = { workspaceId: string; accountId: string }

export function ZaloAccountContacts(account: Account) {
  const t = useTranslations("zaloAccount.contacts")
  const [expanded, setExpanded] = useState(false)
  return (
    <Collapsible
      className="rounded-md border p-2.5"
      onOpenChange={setExpanded}
      open={expanded}
    >
      <CollapsibleTrigger
        render={
          <Button
            className="w-full justify-start"
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("title")}
          </Button>
        }
      />
      <CollapsibleContent>
        {expanded && <ContactOperations {...account} />}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ContactOperations({ workspaceId, accountId }: Account) {
  const t = useTranslations("zaloAccount.contacts")
  const tActions = useTranslations("actions")
  const tProfile = useTranslations("zaloAccount.profile")
  const format = useFormatter()
  const router = useRouter()
  const account = useQuery({
    queryKey: ["zalo-contact-operations", workspaceId, accountId],
    queryFn: async () => {
      const result = await getZaloContactOperationsCapabilityAction(
        workspaceId,
        accountId,
      )
      if (!result?.data) {
        throw new Error("Could not read Zalo contact capabilities")
      }
      return result.data
    },
    retry: false,
    staleTime: 60_000,
  })
  const [method, setMethod] = useState<"username" | "phone">("username")
  const [value, setValue] = useState("")
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [partial, setPartial] = useState(false)
  const [listKind, setListKind] = useState<(typeof categories)[number]>()
  const [selected, setSelected] = useState<Contact>()
  const [relationship, setRelationship] = useState<Relationship | null>()
  const [presence, setPresence] = useState<ZaloAccountPresence[] | null>(null)
  const [proposal, setProposal] = useState<MutationKind>()
  const [note, setNote] = useState("")
  const [uncertain, setUncertain] = useState(new Set<string>())
  const [notice, setNotice] = useState<keyof typeof noticeLabels>()
  const [busy, setBusy] = useState(false)
  const active = useRef(false)

  useEffect(() => {
    if (!presence?.length) {
      return
    }
    const timer = setTimeout(() => setPresence([]), PRESENCE_TTL_MS)
    return () => clearTimeout(timer)
  }, [presence])

  const perform = async (task: () => Promise<void>) => {
    if (active.current) {
      return
    }
    active.current = true
    setBusy(true)
    setNotice(undefined)
    try {
      await task()
    } catch {
      setNotice("failed")
    } finally {
      active.current = false
      setBusy(false)
    }
  }

  const select = (contact?: Contact) => {
    setSelected(contact)
    setRelationship(undefined)
    setProposal(undefined)
    setNotice(undefined)
  }

  const showContacts = (
    results: Contact[] | null,
    complete = true,
    kind?: (typeof categories)[number],
  ) => {
    select()
    setContacts(
      results && [
        ...new Map(results.map((contact) => [contact.uid, contact])).values(),
      ],
    )
    setPartial(!complete)
    setListKind(kind)
    setPresence(null)
  }

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const operation = zaloAccountContactOperationSchema.safeParse(
      method === "username"
        ? { kind: "lookupUsername", username: value }
        : { kind: "lookupPhone", phone: value.trim() },
    )
    if (
      !operation.success ||
      (operation.data.kind !== "lookupPhone" &&
        operation.data.kind !== "lookupUsername")
    ) {
      setNotice("invalidLookup")
      return
    }
    const request = operation.data
    perform(async () => {
      showContacts(null)
      const result = await lookupZaloContactsAction(workspaceId, accountId, {
        commandId: crypto.randomUUID(),
        operation: request,
      })
      if (!result?.data) {
        throw new Error("Zalo contact lookup failed")
      }
      showContacts(result.data.contacts)
    })
  }

  const list = (kind: (typeof categories)[number]) =>
    perform(async () => {
      showContacts(null)
      const result = await listZaloContactsAction(workspaceId, accountId, {
        commandId: crypto.randomUUID(),
        kind,
      })
      if (!result?.data) {
        throw new Error("Zalo contact list failed")
      }
      showContacts(result.data.contacts, result.data.complete, kind)
    })

  const selectedName = selected?.name || selected?.alias || selected?.uid
  const selectedPresence =
    selected && presence?.find((entry) => entry.uid === selected.uid)
  const mutationLabel = (kind: MutationKind) => t(mutationLabels[kind])

  const mutate = (contact: Contact, kind: MutationKind) =>
    perform(async () => {
      const { uid, selectionToken } = contact
      let operation: ZaloAccountContactMutation
      if (kind === "invite") {
        operation = { kind, uid, message: note.trim() }
      } else if (kind === "setAlias") {
        operation = { kind, uid, alias: note.trim() }
      } else if (kind === "hideFeed" || kind === "showFeed") {
        operation = { kind: "blockFeed", uid, blocked: kind === "hideFeed" }
      } else {
        operation = { kind, uid }
      }
      const result = await mutateZaloContactAction(workspaceId, accountId, {
        commandId: crypto.randomUUID(),
        operation,
        selectionToken,
      }).catch(() => undefined)
      const status = result?.data?.status ?? "unknown"
      setProposal(undefined)
      if (status === "unknown") {
        setUncertain((previous) => new Set(previous).add(uid))
        setNotice("unknownOutcome")
      } else {
        setNotice(status)
        if (status === "applied") {
          if (kind === "invite") {
            setRelationship({ isFriend: false, sent: true })
          } else if (kind === "accept") {
            setRelationship({ isFriend: true, received: false })
          } else if (
            kind === "reject" ||
            kind === "cancel" ||
            kind === "remove"
          ) {
            setRelationship({ isFriend: false, received: false, sent: false })
          }
        }
      }
    })

  if (!account.data?.enabled) {
    if (account.isError) {
      return (
        <div className="flex items-center gap-2 px-2 text-sm">
          <p className="text-destructive" role="alert">
            {t("failed")}
          </p>
          <Button
            onClick={() => account.refetch()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {tActions("retry")}
          </Button>
        </div>
      )
    }
    return (
      <p className="px-2 text-muted-foreground text-sm" role="status">
        {account.isPending ? t("loading") : t("disabled")}
      </p>
    )
  }

  const mutations: MutationKind[] = [
    "block",
    "unblock",
    "hideFeed",
    "showFeed",
    "setAlias",
    "clearAlias",
  ]
  if (relationship?.received ?? selected?.request === "incoming") {
    mutations.unshift("accept", "reject")
  } else if (relationship?.sent ?? selected?.request === "outgoing") {
    mutations.unshift("cancel")
  } else if (relationship?.isFriend) {
    mutations.unshift("remove")
  } else if (relationship?.isFriend === false) {
    mutations.unshift("invite")
  }

  let relationshipStatus = t("unknownRelationship")
  if (relationship?.isFriend) {
    relationshipStatus = t("friends")
  } else if (relationship?.received) {
    relationshipStatus = t("receivedRequest")
  } else if (relationship?.sent) {
    relationshipStatus = t("sentRequest")
  } else if (relationship?.isFriend === false) {
    relationshipStatus = tProfile("notFriend")
  }

  return (
    <div aria-busy={busy} className="flex flex-col gap-3 px-2 pt-2">
      <form className="flex flex-wrap gap-2" onSubmit={search}>
        <div className="flex gap-1">
          <Button
            aria-pressed={method === "username"}
            disabled={busy}
            onClick={() => setMethod("username")}
            size="sm"
            type="button"
            variant={method === "username" ? "secondary" : "ghost"}
          >
            {t("byUsername")}
          </Button>
          <Button
            aria-pressed={method === "phone"}
            disabled={busy}
            onClick={() => setMethod("phone")}
            size="sm"
            type="button"
            variant={method === "phone" ? "secondary" : "ghost"}
          >
            {t("byPhone")}
          </Button>
        </div>
        <Input
          aria-label={method === "username" ? t("username") : t("phone")}
          className="min-w-36 flex-1"
          disabled={busy}
          inputMode={method === "phone" ? "tel" : "text"}
          maxLength={100}
          onChange={(event) => setValue(event.currentTarget.value)}
          type="search"
          value={value}
        />
        <Button
          disabled={busy || !value.trim()}
          size="sm"
          type="submit"
          variant="secondary"
        >
          {t("search")}
        </Button>
      </form>
      <div className="flex flex-wrap gap-1">
        {categories.map((kind) => (
          <Button
            disabled={busy}
            key={kind}
            onClick={() => list(kind)}
            size="sm"
            type="button"
            variant="outline"
          >
            {t(categoryLabels[kind])}
          </Button>
        ))}
      </div>
      {notice && (
        <p
          className={
            notice === "applied" ? "text-sm" : "text-destructive text-sm"
          }
          role={notice === "applied" ? "status" : "alert"}
        >
          {t(noticeLabels[notice])}
        </p>
      )}
      {busy && (
        <p className="text-muted-foreground text-sm" role="status">
          {t("loading")}
        </p>
      )}
      {partial && (
        <p className="text-muted-foreground text-xs" role="status">
          {t("partial")}
        </p>
      )}
      {contacts?.length === 0 && (
        <p className="text-muted-foreground text-sm" role="status">
          {t("empty")}
        </p>
      )}
      {contacts && contacts.length > 0 && (
        <>
          {listKind === "closeFriends" && (
            <Button
              className="self-start"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const result = await getZaloContactPresenceAction(
                    workspaceId,
                    accountId,
                    {
                      commandId: crypto.randomUUID(),
                      kind: "onlines",
                      uids: contacts.slice(0, 20).map((contact) => contact.uid),
                    },
                  )
                  setPresence(result?.data?.presence ?? [])
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {t("checkListPresence")}
            </Button>
          )}
          <ul className="flex max-h-40 flex-col gap-1 overflow-auto">
            {contacts.map((contact) => (
              <li key={contact.uid}>
                <Button
                  aria-pressed={selected?.uid === contact.uid}
                  className="w-full justify-start"
                  disabled={busy}
                  onClick={() => select(contact)}
                  size="sm"
                  type="button"
                  variant={
                    selected?.uid === contact.uid ? "secondary" : "ghost"
                  }
                >
                  {contact.name || contact.alias || contact.uid}
                  {contact.alias && contact.name && (
                    <span className="text-muted-foreground">
                      {contact.alias}
                    </span>
                  )}
                  {listKind === "closeFriends" && presence && (
                    <span className="text-muted-foreground text-xs">
                      {t(
                        presenceLabels[
                          presence.find((entry) => entry.uid === contact.uid)
                            ?.status ?? "unknown"
                        ],
                      )}
                    </span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {selected && (
        <div className="flex flex-col gap-2 rounded-md border p-2.5 text-sm">
          <p className="font-medium">{selectedName}</p>
          <div className="flex flex-wrap gap-1">
            <Button
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const result = await openZaloContactConversationAction(
                    workspaceId,
                    accountId,
                    { selectionToken: selected.selectionToken },
                  )
                  if (!result?.data) {
                    throw new Error("Could not open Zalo conversation")
                  }
                  router.push(
                    `/space/${workspaceId}/inbox?conversationId=${encodeURIComponent(result.data.conversationId)}`,
                  )
                })
              }
              size="sm"
              type="button"
              variant="secondary"
            >
              {t("open")}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const result = await getZaloContactRequestStatusAction(
                    workspaceId,
                    accountId,
                    {
                      commandId: crypto.randomUUID(),
                      selectionToken: selected.selectionToken,
                      uid: selected.uid,
                    },
                  )
                  if (!result?.data) {
                    throw new Error("Could not read Zalo relationship")
                  }
                  setRelationship(result.data.requestStatus)
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {t("checkRelationship")}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const result = await getZaloContactPresenceAction(
                    workspaceId,
                    accountId,
                    {
                      commandId: crypto.randomUUID(),
                      kind: "lastOnline",
                      selectionToken: selected.selectionToken,
                      uid: selected.uid,
                    },
                  )
                  setPresence(result?.data?.presence ?? [])
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {t("checkPresence")}
            </Button>
          </div>
          {relationship !== undefined && (
            <p role="status">{relationshipStatus}</p>
          )}
          {presence && (
            <p role="status">
              {t(presenceLabels[selectedPresence?.status ?? "unknown"])}
              {selectedPresence?.status === "offline" &&
                selectedPresence.lastOnlineMs &&
                ` · ${t("lastOnline", { date: format.dateTime(new Date(selectedPresence.lastOnlineMs), { dateStyle: "medium", timeStyle: "short" }) })}`}
            </p>
          )}
          {!(proposal || uncertain.has(selected.uid)) && (
            <div className="flex flex-wrap gap-1">
              {mutations.map((kind) => (
                <Button
                  disabled={busy}
                  key={kind}
                  onClick={() => {
                    setProposal(kind)
                    setNote(kind === "setAlias" ? (selected.alias ?? "") : "")
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {mutationLabel(kind)}
                </Button>
              ))}
            </div>
          )}
          {proposal && (
            <div className="flex flex-col gap-2 rounded border p-2">
              <p>
                {t("confirmChange", {
                  action: mutationLabel(proposal),
                  name: selectedName ?? selected.uid,
                })}
              </p>
              {(proposal === "invite" || proposal === "setAlias") && (
                <Input
                  aria-label={
                    proposal === "invite" ? t("inviteNote") : t("alias")
                  }
                  disabled={busy}
                  maxLength={proposal === "invite" ? 150 : 100}
                  onChange={(event) => setNote(event.currentTarget.value)}
                  value={note}
                />
              )}
              <div className="flex gap-1">
                <Button
                  disabled={busy || (proposal === "setAlias" && !note.trim())}
                  onClick={() => mutate(selected, proposal)}
                  size="sm"
                  type="button"
                >
                  {tActions("confirm")}
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => setProposal(undefined)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {tActions("cancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
