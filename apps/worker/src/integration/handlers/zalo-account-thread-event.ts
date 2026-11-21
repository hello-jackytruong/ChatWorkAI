import { logProviderError } from "@chatbotx.io/business/error-log"
import { zaloAccountMessageLifecycleService } from "@chatbotx.io/business/zalo-account/lifecycle"
import type { IntegrationJobZaloAccountThreadEvent } from "@chatbotx.io/worker-config"
import type { Job } from "bullmq"
import { logger } from "../../lib/logger"
import { handleMessageStatus } from "./message-status"

export async function handleZaloAccountThreadEvent(
  input: IntegrationJobZaloAccountThreadEvent["data"],
  job?: Pick<Job, "attemptsMade" | "opts">,
): Promise<void> {
  const result = await zaloAccountMessageLifecycleService.handle(input)
  if (
    input.event.type === "receipt" &&
    input.event.threadType === "user" &&
    result.directSeenAt
  ) {
    await handleMessageStatus({
      integrationType: "zaloAccount",
      integrationIdentifier: input.accountId,
      workspaceId: input.workspaceId,
      zaloAccountRoute: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      payload: {
        messageId: `za:${encodeURIComponent(input.accountId)}:user:${encodeURIComponent(input.event.threadId)}:${encodeURIComponent(input.event.providerMessageId)}`,
        recipientId: input.event.threadId,
        status: input.event.status,
        timestamp:
          input.event.status === "read"
            ? result.directSeenAt
            : new Date(input.event.timestampMs).toISOString(),
      },
    })
  }
  if (result.missingTarget) {
    if ((job?.attemptsMade ?? 0) < (job?.opts.attempts ?? 5) - 1) {
      throw new Error("Zalo lifecycle target is not available yet")
    }
    logger.warn(
      {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        threadId: input.event.threadId,
        type: input.event.type,
      },
      "Zalo lifecycle target remained missing after bounded retries",
    )
    await logProviderError({
      provider: "zaloAccount",
      workspaceId: input.workspaceId,
      sourceId: input.event.threadId,
      error: new Error(
        "Zalo lifecycle target remained missing after bounded retries",
      ),
    })
  }
}
