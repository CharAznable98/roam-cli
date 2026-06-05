import { Bell, BellOff } from "lucide-react";
import { useState } from "react";
import { getNotificationSupport } from "../lib/pwa";

export function PushSettings() {
  const [permission, setPermission] = useState(getNotificationSupport);
  const isSupported = permission !== "unsupported";

  const requestPermission = () => {
    if (!("Notification" in window)) {
      setPermission("unsupported");
      return;
    }

    Notification.requestPermission().then(setPermission).catch(() => setPermission(Notification.permission));
  };

  return (
    <section className="push-panel" aria-label="Web Push">
      <div className="flex items-start gap-3">
        <div className="push-icon">{isSupported ? <Bell size={18} /> : <BellOff size={18} />}</div>
        <div className="min-w-0 flex-1">
          <h2 className="panel-title">Web Push</h2>
          <p className="mt-1 text-sm text-ink-600">Notification plumbing placeholder for approval and runner status updates.</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="rounded bg-ink-100 px-2 py-1 text-xs font-medium text-ink-700">{permission}</span>
            <button className="small-button" type="button" disabled={!isSupported || permission === "granted"} onClick={requestPermission}>
              Enable
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
