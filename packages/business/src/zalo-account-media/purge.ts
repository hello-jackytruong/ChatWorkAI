import { ScheduleJobData, scheduleQueue } from "@chatbotx.io/worker-config"
import { WorkspacePurgeIncompleteError } from "../errors"
import { zaloAccountMediaService } from "./service"

/** Keep the object manifest until the existing low worker confirms remote deletion. */
export async function purgeZaloAccountMediaForWorkspace(
  workspaceId: string,
  options: { deadlineAt: number; batchSize?: number },
): Promise<number> {
  const scopes = await zaloAccountMediaService.workspaceScopes({
    workspaceId,
    limit: 50,
  })
  if (!scopes.length) {
    return 0
  }
  for (const scope of scopes) {
    if (Date.now() >= options.deadlineAt) {
      throw new WorkspacePurgeIncompleteError(
        workspaceId,
        "ZaloAccountMediaAsset",
      )
    }
    await zaloAccountMediaService.close(scope)
    await zaloAccountMediaService.releaseOwners(scope)
  }
  const count = await zaloAccountMediaService.drainConfirmed({
    workspaceId,
    limit: Math.max(1, Math.min(100, options.batchSize ?? 100)),
  })
  if (await zaloAccountMediaService.workspaceRemaining({ workspaceId })) {
    await scheduleQueue.add(
      ScheduleJobData.recoverZaloAccountMedia,
      { type: ScheduleJobData.recoverZaloAccountMedia, data: {} },
      {
        jobId: `recover-zalo-media-${workspaceId}-${Math.floor(Date.now() / 60_000)}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    )
    throw new WorkspacePurgeIncompleteError(
      workspaceId,
      "ZaloAccountMediaAsset",
    )
  }
  return count
}
