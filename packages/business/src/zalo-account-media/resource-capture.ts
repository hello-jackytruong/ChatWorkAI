import type { DatabaseClient } from "@chatbotx.io/database/client"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { getZaloAccountMediaPolicy } from "./policy"
import { zaloAccountMediaService } from "./service"
import type { MediaScope, RegisterMediaResource } from "./types"

export async function captureZaloAccountResourceMedia(
  input: MediaScope & {
    resources: {
      ownerKind: RegisterMediaResource["ownerKind"]
      ownerId: string
      avatarUrl?: string | null
      coverUrl?: string | null
      coverConsumed?: boolean
      sourceRevision?: string
    }[]
    tx?: DatabaseClient
  },
) {
  if (!getZaloAccountMediaPolicy().enabled) {
    return []
  }
  const resources: RegisterMediaResource[] = []
  for (const resource of input.resources) {
    for (const [role, url] of [
      ["avatar", resource.avatarUrl],
      ["cover", resource.coverConsumed ? resource.coverUrl : null],
    ] as const) {
      if (!url) {
        continue
      }
      // Token rotation does not create a new owner revision; content-path change does.
      const parsed = new URL(url)
      const revision =
        resource.sourceRevision ??
        (await sha256Hex(`${parsed.origin}${parsed.pathname}`))
      resources.push({
        ownerKind: resource.ownerKind,
        ownerId: resource.ownerId,
        kind: "image",
        role,
        sourceRevision: revision,
        providerResourceId: `${resource.ownerKind}:${resource.ownerId}:${role}`,
        source: { type: "provider_url", url },
        priority: 20,
      })
    }
  }
  const results: Awaited<
    ReturnType<typeof zaloAccountMediaService.registerResources>
  > = []
  for (let offset = 0; offset < resources.length; offset += 50) {
    results.push(
      ...(await zaloAccountMediaService.registerResources({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        resources: resources.slice(offset, offset + 50),
        tx: input.tx,
      })),
    )
  }
  return results
}
