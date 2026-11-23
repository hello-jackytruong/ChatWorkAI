import { zaloAccountMediaResourcesSchema } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { zaloAccountService } from "../zalo-account/service"
import { zaloAccountCommandTransportService } from "../zalo-account/transport.service"
import { getZaloAccountMediaPolicy } from "../zalo-account-media/policy"
import { zaloAccountMediaService } from "../zalo-account-media/service"
import { buildZaloMessageResources } from "./zalo-account-capture"

type CaptureInput = Parameters<typeof buildZaloMessageResources>[0]
export async function captureZaloAccountMessage(
  input: Omit<CaptureInput, "accountId"> & {
    channel: string
    inboxId: string
    accountId?: string
    attributes?: Record<string, unknown> | null
  },
) {
  if (input.channel !== "zaloAccount" || !getZaloAccountMediaPolicy().enabled) {
    return
  }
  const account = input.accountId
    ? { id: input.accountId }
    : await zaloAccountService.findByInboxId({
        workspaceId: input.workspaceId,
        inboxId: input.inboxId,
      })
  if (!account) {
    throw new Error("Zalo media account is missing")
  }
  const attributes = input.attributes?.zaloAccount as
    | Record<string, unknown>
    | undefined
  const parsed = zaloAccountMediaResourcesSchema.safeParse(
    input.descriptors ?? attributes?.mediaResources ?? [],
  )
  let descriptors = parsed.success ? parsed.data : []
  const stickerIds = [
    ...new Set(
      descriptors.flatMap((item) =>
        item.kind === "sticker" && !item.url && item.providerResourceId
          ? [item.providerResourceId]
          : [],
      ),
    ),
  ].slice(0, 20)
  if (stickerIds.length) {
    // Detail lookup is bounded and optional: a missing provider response remains a truthful missing source.
    const details = await zaloAccountCommandTransportService
      .getStickerResourcesAndWait({
        workspaceId: input.workspaceId,
        accountId: account.id,
        inboxId: input.inboxId,
        commandId: createId(),
        ttlMs: 10_000,
        waitTimeoutMs: 5000,
        stickerIds,
      })
      .catch(() => [])
    descriptors = descriptors
      .flatMap((descriptor) => {
        const detail =
          descriptor.kind === "sticker" && !descriptor.url
            ? details.find(
                (item) => item.stickerId === descriptor.providerResourceId,
              )
            : undefined
        return detail?.resources.length
          ? detail.resources.map((resource) => ({
              ...resource,
              slot: descriptor.slot,
            }))
          : [descriptor]
      })
      .slice(0, 12)
  }
  const resources = buildZaloMessageResources({
    ...input,
    accountId: account.id,
    descriptors,
  })
  if (resources.length) {
    await zaloAccountMediaService.registerResources({
      workspaceId: input.workspaceId,
      accountId: account.id,
      resources,
    })
  }
}
