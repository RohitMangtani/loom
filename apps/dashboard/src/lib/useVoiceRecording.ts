"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Wraps the browser's Web Speech API (SpeechRecognition) for tap-to-talk.
 * Auto-restarts recognition if the browser times out (common on mobile Chrome).
 * Returns false from start() if the browser doesn't support speech recognition.
 */
export function useVoiceRecording() {
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const recognitionRef = useRef<ReturnType<typeof createRecognition> | null>(null);
  const transcriptRef = useRef("");
  const stoppedRef = useRef(false);

  const start = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return false;

    stoppedRef.current = false;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";

    let finalText = "";

    r.onresult = (e: { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } } }) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      transcriptRef.current = finalText + interim;
      setTranscript(finalText + interim);
    };

    r.onerror = (e: { error: string }) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stoppedRef.current = true;
        setRecording(false);
      }
    };

    r.onend = () => {
      // Auto-restart if the browser timed out but user hasn't tapped to stop.
      // This keeps the mic hot on mobile Chrome which auto-stops after silence.
      if (!stoppedRef.current && recognitionRef.current === r) {
        try {
          r.start();
        } catch {
          setRecording(false);
        }
      }
    };

    recognitionRef.current = r;
    transcriptRef.current = "";
    setTranscript("");
    setRecording(true);
    r.start();
    return true;
  }, []);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    const r = recognitionRef.current;
    const text = transcriptRef.current.trim();
    if (r) {
      r.stop();
      recognitionRef.current = null;
    }
    transcriptRef.current = "";
    setRecording(false);
    setTranscript("");
    return text;
  }, []);

  return { recording, transcript, start, stop };
}

// Type helper for the ref (SpeechRecognition instance shape varies by browser)
function createRecognition() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return SR ? new SR() : null;
}
