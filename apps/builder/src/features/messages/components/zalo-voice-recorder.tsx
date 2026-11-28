"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { MicIcon, SquareIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useRef, useState } from "react"
import { ZALO_COMPOSER_MAX_DEVICE_FILE_BYTES } from "../schema/mutation"

type Recording = { file: File; url: string }
type ActiveCapture = { recorder: MediaRecorder; stream: MediaStream }
const supportedMimeTypes = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"]
const stopTracks = (stream: MediaStream) => {
  for (const track of stream.getTracks()) {
    track.stop()
  }
}

export function ZaloVoiceRecorder({
  onSend,
}: {
  onSend: (file: File) => boolean
}) {
  const t = useTranslations()
  const active = useRef<ActiveCapture | null>(null)
  const generation = useRef(0)
  const [recording, setRecording] = useState<Recording>()
  const [state, setState] = useState<
    "idle" | "requesting" | "recording" | "finishing" | "unavailable"
  >("idle")

  const cancelCapture = useCallback(() => {
    ++generation.current
    const capture = active.current
    active.current = null
    if (capture) {
      if (capture.recorder.state !== "inactive") {
        capture.recorder.stop()
      }
      stopTracks(capture.stream)
    }
  }, [])
  useEffect(() => cancelCapture, [cancelCapture])
  useEffect(() => {
    if (recording) {
      return () => URL.revokeObjectURL(recording.url)
    }
  }, [recording])

  const start = async () => {
    const started = ++generation.current
    const mimeType =
      typeof MediaRecorder === "function"
        ? supportedMimeTypes.find((type) => MediaRecorder.isTypeSupported(type))
        : undefined
    if (
      !mimeType ||
      typeof navigator.mediaDevices?.getUserMedia !== "function"
    ) {
      setState("unavailable")
      return
    }
    setState("requesting")
    let stream: MediaStream | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (generation.current !== started) {
        stopTracks(stream)
        return
      }
      const recorder = new MediaRecorder(stream, { mimeType })
      active.current = { recorder, stream }
      const parts: Blob[] = []
      let bytes = 0
      recorder.addEventListener("dataavailable", (event) => {
        if (generation.current !== started || event.data.size === 0) {
          return
        }
        bytes += event.data.size
        if (bytes > ZALO_COMPOSER_MAX_DEVICE_FILE_BYTES) {
          cancelCapture()
          setState("unavailable")
          return
        }
        parts.push(event.data)
      })
      recorder.addEventListener("error", () => {
        if (generation.current === started) {
          cancelCapture()
          setState("unavailable")
        }
      })
      recorder.addEventListener("stop", () => {
        if (generation.current !== started) {
          return
        }
        active.current = null
        stopTracks(recorder.stream)
        if (!parts.length) {
          setState("unavailable")
          return
        }
        const file = new File(parts, "voice.m4a", { type: "audio/mp4" })
        setRecording({ file, url: URL.createObjectURL(file) })
        setState("idle")
      })
      recorder.start(500)
      setState("recording")
    } catch {
      if (stream) {
        stopTracks(stream)
      }
      if (generation.current === started) {
        active.current = null
        setState("unavailable")
      }
    }
  }

  const finish = () => {
    const capture = active.current
    if (capture?.recorder.state === "recording") {
      setState("finishing")
      capture.recorder.stop()
    }
  }

  if (recording) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <audio
          aria-label={t("fields.lastUserInputTypes.audio")}
          className="min-w-0 max-w-full flex-1"
          controls
          preload="none"
          src={recording.url}
        >
          <track default kind="captions" />
        </audio>
        <Button
          onClick={() => setRecording(undefined)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("actions.remove")}
        </Button>
        <Button
          onClick={() => {
            if (onSend(recording.file)) {
              setRecording(undefined)
            }
          }}
          size="sm"
          type="button"
        >
          {t("actions.send")}
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {state === "recording" ? (
        <Button onClick={finish} size="sm" type="button" variant="outline">
          <SquareIcon aria-hidden />
          {t("actions.stop")}
        </Button>
      ) : (
        <Button
          disabled={state === "requesting" || state === "finishing"}
          onClick={start}
          size="sm"
          type="button"
          variant="outline"
        >
          <MicIcon aria-hidden />
          {t("zaloAccount.composer.recordVoice")}
        </Button>
      )}
      {(state === "requesting" || state === "finishing") && (
        <span className="text-muted-foreground text-xs" role="status">
          {t("actions.loading")}
        </span>
      )}
      {state === "unavailable" && (
        <p className="text-muted-foreground text-xs" role="status">
          {t("zaloAccount.composer.voiceUnavailable")}
        </p>
      )}
    </div>
  )
}
