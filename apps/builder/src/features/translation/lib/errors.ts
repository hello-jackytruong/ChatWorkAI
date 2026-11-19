import { ChatbotXException } from "@chatbotx.io/business/errors"
import {
  TRANSLATION_API_ERRORS,
  type TranslationApiErrorCode,
} from "../schema/errors"

export const translationException = (
  code: TranslationApiErrorCode,
): ChatbotXException => {
  const { message, code: exceptionCode, status } = TRANSLATION_API_ERRORS[code]
  return new ChatbotXException(message, exceptionCode, status)
}
