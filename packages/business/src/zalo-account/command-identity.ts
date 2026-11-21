import { sha256Hex } from "@chatbotx.io/utils/crypto"

// Redis command results use a global key. Scope caller-controlled IDs before
// transport so another workspace/account cannot reuse a cached result.
export async function scopedZaloCommandId(
  input: { workspaceId: string; accountId: string; commandId: string },
  operation: string,
): Promise<string> {
  return `zalo-${operation}-${await sha256Hex(JSON.stringify([input.workspaceId, input.accountId, operation, input.commandId]))}`
}
