import { z } from "zod"

export const zaloAccountGroupAutomationModes = z.enum([
  "disabled",
  "mentionOnly",
  "all",
])
export type ZaloAccountGroupAutomationMode = z.infer<
  typeof zaloAccountGroupAutomationModes
>

export const zaloAccountThreadTypes = z.enum(["user", "group"])
export const zaloAccountSendAttemptStatuses = z.enum([
  "pending",
  "applied",
  "failed",
  "unknown",
])
export const zaloAccountSendOrigins = z.enum(["inbox", "flow", "api"])

export const integrationTypes = z.enum([
  "activeCampaign",
  "api",
  "chatbotx",
  "claude",
  "deepseek",
  "drip",
  "facebookAds",
  "gemini",
  "getResponse",
  "klaviyo",
  "googleAds",
  "googleCalendar",
  "googleSheets",
  "instagram",
  "instagramFacebook",
  "line",
  "threads",
  "mailchimp",
  "mailerLite",
  "metaCatalog",
  "messenger",
  "moosend",
  "muse",
  "openai",
  "openaiCompatible",
  "openrouter",
  "outlookCalendar",
  "sendGrid",
  "smtp",
  "telegram",
  "tiktok",
  "webchat",
  "whatsapp",
  "zalo",
  "zaloAccount",
])
export type IntegrationType = z.infer<typeof integrationTypes>

// Facebook/Instagram user who authorized the channel connection. `avatar` is a
// storage path (uploaded copy of the provider's profile picture), not the
// provider URL.
export const integrationUserInfoSchema = z.object({
  userId: z.string().min(1),
  userName: z.string(),
  userAccessToken: z.string().min(1),
  avatar: z.string().optional(),
})
export type IntegrationUserInfo = z.infer<typeof integrationUserInfoSchema>
