import { stepTypes } from "../../steps/step-action"
import { defineChannelFlowPolicy } from "./define"

/** Personal Zalo v1 supports only the direct message slices implemented by the gateway. */
export const zaloAccountFlowPolicy = defineChannelFlowPolicy({
  limits: {
    buttonCount: 0,
    cardButtonCount: 0,
    buttonLabel: 20,
    text: 2000,
  },
  nativeButtonTypes: [],
  supported: [
    stepTypes.enum.sendText,
    stepTypes.enum.sendImage,
    stepTypes.enum.sendFile,
  ],
  noButtons: [
    stepTypes.enum.sendText,
    stepTypes.enum.sendImage,
    stepTypes.enum.sendFile,
  ],
})
