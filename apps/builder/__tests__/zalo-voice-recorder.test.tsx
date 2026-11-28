import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { ZaloVoiceRecorder } from "@/features/messages/components/zalo-voice-recorder"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let container: HTMLDivElement | undefined
let root: Root | undefined
const originalDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
)

function renderRecorder(
  getUserMedia: () => Promise<MediaStream>,
  supportsRecording = true,
) {
  vi.stubGlobal(
    "MediaRecorder",
    Object.assign(() => undefined, {
      isTypeSupported: () => supportsRecording,
    }),
  )
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(<ZaloVoiceRecorder onSend={() => true} />))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  if (originalDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalDevices)
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices")
  }
  vi.unstubAllGlobals()
})

test("opens the microphone only from the record control and stops a stream arriving after close", async () => {
  const request = Promise.withResolvers<MediaStream>()
  const getUserMedia = vi.fn(() => request.promise)
  const stop = vi.fn()
  const element = renderRecorder(getUserMedia)
  expect(getUserMedia).not.toHaveBeenCalled()

  act(() => element.querySelector("button")?.click())
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
  act(() => root?.unmount())
  root = undefined
  await act(async () => {
    request.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    await request.promise
  })
  expect(stop).toHaveBeenCalledOnce()
})

test("shows the file fallback after the browser denies microphone access", async () => {
  const getUserMedia = vi
    .fn<() => Promise<MediaStream>>()
    .mockRejectedValue(new Error("denied"))
  const element = renderRecorder(getUserMedia)
  await act(async () => {
    element.querySelector("button")?.click()
    await expect(getUserMedia.mock.results[0]?.value).rejects.toThrow("denied")
  })
  expect(element.textContent).toContain("zaloAccount.composer.voiceUnavailable")
  expect(element.querySelector("audio")).toBeNull()
})

test("does not request the microphone when AAC recording is unavailable", () => {
  const getUserMedia = vi.fn<() => Promise<MediaStream>>()
  const element = renderRecorder(getUserMedia, false)
  act(() => element.querySelector("button")?.click())
  expect(getUserMedia).not.toHaveBeenCalled()
  expect(element.textContent).toContain("zaloAccount.composer.voiceUnavailable")
})
