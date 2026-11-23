import {
  contactInboxService,
  resolveContactAvatarUrl,
  resolveTenantSettings,
} from "@chatbotx.io/business"
import { toPublicStorageUrl } from "@chatbotx.io/business/utils"
import { zaloAccountService } from "@chatbotx.io/business/zalo-account"
import { zaloAccountMediaReadService } from "@chatbotx.io/business/zalo-account-media"
import { sha256Hex } from "@chatbotx.io/utils/crypto"

type ContactWithAvatar = {
  id: string
  avatar: string | null
}

/**
 * `publicUrls: true` also turns a stored storage key into its absolute URL for
 * callers with no client-side resolver (the public API). The builder UI keeps
 * the key and resolves it in the browser.
 */
export async function resolveContactAvatars<T extends ContactWithAvatar>(
  contacts: readonly T[],
  workspaceId: string,
  options: { publicUrls?: boolean } = {},
): Promise<T[]> {
  const storageUrl = options.publicUrls
    ? (await resolveTenantSettings({ workspaceId })).storageUrl
    : null
  const finalize = (key: string) =>
    storageUrl ? toPublicStorageUrl(key, storageUrl) : key

  const contactInboxes = await contactInboxService.listByContactIds({
    workspaceId,
    contactIds: contacts.map((contact) => contact.id),
  })
  const contactInboxesByContactId = new Map<string, typeof contactInboxes>()

  for (const contactInbox of contactInboxes) {
    const rows = contactInboxesByContactId.get(contactInbox.contactId) ?? []
    rows.push(contactInbox)
    contactInboxesByContactId.set(contactInbox.contactId, rows)
  }

  const zaloAvatars = await resolveZaloContactAvatarMap(
    contacts,
    contactInboxes,
    workspaceId,
  )
  return await Promise.all(
    contacts.map(async (contact) => ({
      ...contact,
      avatar:
        zaloAvatars.get(contact.id) ??
        (await resolveContactAvatarUrl(
          {
            workspaceId,
            contact,
            contactInboxes: contactInboxesByContactId.get(contact.id) ?? [],
          },
          finalize,
        )),
    })),
  )
}

type AvatarInbox = {
  contactId: string
  inboxId: string | null
  sourceId: string
  channel: string
}
export async function resolveZaloContactAvatarMap(
  contacts: readonly ContactWithAvatar[],
  contactInboxes: readonly AvatarInbox[],
  workspaceId: string,
): Promise<Map<string, string>> {
  const candidates = contactInboxes.filter(
    (inbox) =>
      inbox.channel === "zaloAccount" &&
      inbox.inboxId &&
      contacts.some(
        (contact) =>
          contact.id === inbox.contactId &&
          (!contact.avatar ||
            contact.avatar.startsWith("https://") ||
            contact.avatar.startsWith("http://")),
      ),
  )
  if (!candidates.length) {
    return new Map()
  }
  const accounts = await zaloAccountService.listByWorkspace({ workspaceId })
  const owners: Array<
    Parameters<
      typeof zaloAccountMediaReadService.projectProfiles
    >[0]["owners"][number] & { contactId: string }
  > = []
  for (const inbox of candidates) {
    const account = accounts.find((row) => row.inboxId === inbox.inboxId)
    const contact = contacts.find((row) => row.id === inbox.contactId)
    if (!(account && contact)) {
      continue
    }
    const group = inbox.sourceId.startsWith("za:group:")
    let ownerId = inbox.sourceId
    if (group) {
      try {
        ownerId = decodeURIComponent(inbox.sourceId.slice("za:group:".length))
      } catch {
        continue
      }
    }
    let sourceRevision: string | undefined
    if (contact.avatar) {
      try {
        const source = new URL(contact.avatar)
        sourceRevision = await sha256Hex(`${source.origin}${source.pathname}`)
      } catch {
        continue
      }
    }
    owners.push({
      contactId: contact.id,
      accountId: account.id,
      ownerKind: group ? ("group" as const) : ("contact" as const),
      ownerId,
      ...(sourceRevision ? { sourceRevision } : {}),
    })
  }
  const result = new Map<string, string>()
  for (let offset = 0; offset < owners.length; offset += 50) {
    const page = owners.slice(offset, offset + 50)
    const projection = await zaloAccountMediaReadService.projectProfiles({
      workspaceId,
      owners: page.map(({ contactId, ...owner }) => owner),
    })
    for (const owner of page) {
      const avatar = projection.get(
        JSON.stringify([owner.accountId, owner.ownerKind, owner.ownerId]),
      )?.avatarUrl
      if (avatar) {
        result.set(owner.contactId, avatar)
      }
    }
  }
  return result
}
