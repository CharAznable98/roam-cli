import { Mic, MicOff } from "lucide-react";
import { useMemo, useRef, useState } from "react";

type VoiceButtonProps = {
  onTranscript: (value: string) => void;
};

export function VoiceButton({ onTranscript }: VoiceButtonProps) {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [isListening, setIsListening] = useState(false);
  const Recognition = useMemo(() => window.SpeechRecognition ?? window.webkitSpeechRecognition, []);
  const isSupported = Boolean(Recognition);

  const toggle = () => {
    if (!Recognition) {
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const latest = event.results[event.results.length - 1]?.[0]?.transcript;
      if (latest) {
        onTranscript(latest);
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  };

  return (
    <button
      type="button"
      className="icon-button"
      disabled={!isSupported}
      aria-label={isSupported ? "Dictate message" : "Speech recognition unavailable"}
      title={isSupported ? "Dictate message" : "Speech recognition unavailable"}
      onClick={toggle}
    >
      {isSupported && isListening ? <MicOff size={18} /> : <Mic size={18} />}
    </button>
  );
}
