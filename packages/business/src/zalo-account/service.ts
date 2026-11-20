import { integrationZaloAccountRepository } from "@chatbotx.io/database/repositories"
import type { IntegrationZaloAccountPublicModel } from "@chatbotx.io/database/types"
import type { ZaloAccountAuth } from "@chatbotx.io/sdk"
import {
  connectionIdentityMismatchException,
  notFoundException,
} from "../errors"
import { decryptZaloAccountAuth, encryptZaloAccountAuth } from "./auth"

const toPublic = (
  row: Awaited<
    ReturnType<
      typeof integrationZaloAccountRepository.findByInboxIdForWorkspace
    >
  >,
): IntegrationZaloAccountPublicModel | null => {
  if (!row) {
    return null
  }
  const { encryptedAuth: _encryptedAuth, ...metadata } = row
  return metadata
}

export const zaloAccountService = {
  async listByWorkspace(input: {
    workspaceId: string
  }): Promise<IntegrationZaloAccountPublicModel[]> {
    const rows = await integrationZaloAccountRepository.listByWorkspace(input)
    return rows.flatMap((row) => {
      const metadata = toPublic(row)
      return metadata ? [metadata] : []
    })
  },

  async findById(input: {
    workspaceId: string
    id: string
  }): Promise<IntegrationZaloAccountPublicModel | null> {
    return toPublic(
      await integrationZaloAccountRepository.findByIdForWorkspace(input),
    )
  },

  async listActiveRuntimeAccounts(input: {
    afterId?: string
    limit: number
  }): Promise<Array<{ id: string; workspaceId: string; inboxId: string }>> {
    return await integrationZaloAccountRepository.listActiveRuntimeAccounts(
      input,
    )
  },

  async findByInboxId(input: {
    workspaceId: string
    inboxId: string
  }): Promise<IntegrationZaloAccountPublicModel | null> {
    return toPublic(
      await integrationZaloAccountRepository.findByInboxIdForWorkspace(input),
    )
  },

  async findByUid(input: {
    workspaceId: string
    zaloUid: string
  }): Promise<IntegrationZaloAccountPublicModel | null> {
    return toPublic(
      await integrationZaloAccountRepository.findByUidForWorkspace(input),
    )
  },

  /** Internal runtime-only secret access; never expose this result through app/API projections. */
  async loadAuthorizationForRuntime(input: {
    workspaceId: string
    inboxId: string
  }): Promise<ZaloAccountAuth> {
    const row =
      await integrationZaloAccountRepository.findByInboxIdForWorkspace(input)
    if (!row) {
      throw notFoundException("Zalo Account connection not found")
    }
    return await decryptZaloAccountAuth(row)
  },

  /** Gateway-only account lookup with validated decrypted authorization. */
  async loadRuntimeAccount(input: {
    workspaceId: string
    accountId: string
  }): Promise<{ auth: ZaloAccountAuth; zaloUid: string }> {
    const row = await integrationZaloAccountRepository.findByIdForWorkspace({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!row) {
      throw notFoundException("Zalo Account connection not found")
    }
    return {
      auth: await decryptZaloAccountAuth(row),
      zaloUid: row.zaloUid,
    }
  },

  async saveAuthorization(input: {
    workspaceId: string
    inboxId: string
    auth: ZaloAccountAuth
    name: string
    avatarUrl: string | null
    sessionVerifiedAt: Date
  }): Promise<IntegrationZaloAccountPublicModel> {
    const existing =
      await integrationZaloAccountRepository.findByInboxIdForWorkspace({
        workspaceId: input.workspaceId,
        inboxId: input.inboxId,
      })
    if (!existing) {
      throw notFoundException("Zalo Account connection not found")
    }
    if (existing.zaloUid !== input.auth.zaloUid) {
      throw connectionIdentityMismatchException()
    }
    const encryptedAuth = await encryptZaloAccountAuth(
      input.workspaceId,
      input.inboxId,
      input.auth,
    )
    const row =
      await integrationZaloAccountRepository.updateAuthorizationAndProfile({
        workspaceId: input.workspaceId,
        inboxId: input.inboxId,
        encryptedAuth,
        name: input.name,
        avatarUrl: input.avatarUrl,
        sessionVerifiedAt: input.sessionVerifiedAt,
      })
    const metadata = toPublic(row)
    if (!metadata) {
      throw notFoundException("Zalo Account connection not found")
    }
    return metadata
  },
}
