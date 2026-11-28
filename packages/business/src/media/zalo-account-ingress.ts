import { zaloAccountMediaResourcesSchema } from "@chatbotx.io/sdk"
import {
  requestZaloAccountMedia,
  type ZaloAccountMediaJobData,
} from "@chatbotx.io/worker-config"
import { zaloAccountService } from "../zalo-account/service"
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
    priority?: "backfill"
  },
) {
  if (input.channel !== "zaloAccount" || !getZaloAccountMediaPolicy().enabled) {
    return 0
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
  const descriptors = parsed.success ? parsed.data : []
  const resources = buildZaloMessageResources({
    ...input,
    accountId: account.id,
    descriptors,
  }).map((resource) =>
    input.priority === "backfill" ? { ...resource, priority: 30 } : resource,
  )
  if (resources.length) {
    const references = await zaloAccountMediaService.registerResources({
      workspaceId: input.workspaceId,
      accountId: account.id,
      resources,
    })
    // registerResources owns and commits its transaction before returning here.
    const jobs = new Map<string, ZaloAccountMediaJobData>()
    for (const [index, reference] of references.entries()) {
      if (!resources[index]?.source) {
        continue
      }
      jobs.set(reference.assetId, {
        type: "transfer",
        data: {
          workspaceId: input.workspaceId,
          accountId: account.id,
          assetId: reference.assetId,
          priority: input.priority ?? "live",
          createdAt: reference.createdAt.getTime(),
        },
      })
    }
    if (jobs.size) {
      requestZaloAccountMedia([...jobs.values()])
    }
    return jobs.size
  }
  return 0
}
