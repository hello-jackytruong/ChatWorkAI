import type { EncryptedData } from "@chatbotx.io/encryption"
import { encryptedDataSchema, encryptUtils } from "@chatbotx.io/encryption"
import {
  type AuthValue,
  type ZaloAccountAuth,
  zaloAccountAuthSchema,
} from "@chatbotx.io/sdk"

const authAad = (workspaceId: string, inboxId: string) =>
  `zalo-account:${workspaceId}:${inboxId}:authorization`

export const encryptZaloAccountAuth = async (
  workspaceId: string,
  inboxId: string,
  auth: AuthValue,
): Promise<EncryptedData> => {
  const validated = zaloAccountAuthSchema.parse(auth)
  return await encryptUtils.encryptObject(
    validated,
    authAad(workspaceId, inboxId),
  )
}

export const decryptZaloAccountAuth = async (input: {
  workspaceId: string
  inboxId: string
  encryptedAuth: unknown
}): Promise<ZaloAccountAuth> => {
  const decrypted = await encryptUtils.decryptObject(
    encryptedDataSchema.parse(input.encryptedAuth),
    zaloAccountAuthSchema,
    authAad(input.workspaceId, input.inboxId),
  )
  return zaloAccountAuthSchema.parse(decrypted)
}

export const zaloAccountChannelAuthCodec = {
  encode: (auth: AuthValue, workspaceId: string, inboxId: string) =>
    encryptZaloAccountAuth(workspaceId, inboxId, auth),
  decode: (stored: unknown, workspaceId: string, inboxId: string) =>
    decryptZaloAccountAuth({
      workspaceId,
      inboxId,
      encryptedAuth: stored,
    }),
}
