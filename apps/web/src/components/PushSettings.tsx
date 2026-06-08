import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { getNotificationSupport } from "../lib/pwa";

export function PushSettings() {
  const [permission, setPermission] = useState(getNotificationSupport);
  const [requestState, setRequestState] = useState<"idle" | "requesting" | "requested" | "error">("idle");
  const isSupported = permission !== "unsupported";

  useEffect(() => {
    if (!isSupported || !("permissions" in navigator)) {
      return;
    }
    let status: PermissionStatus | undefined;
    let cancelled = false;

    void navigator.permissions
      .query({ name: "notifications" as PermissionName })
      .then((nextStatus) => {
        if (cancelled) return;
        status = nextStatus;
        setPermission(getNotificationSupport());
        status.onchange = () => setPermission(getNotificationSupport());
      })
      .catch(() => {
        // Browsers may expose Notification without Permissions API support.
      });

    return () => {
      cancelled = true;
      if (status) {
        status.onchange = null;
      }
    };
  }, [isSupported]);

  const requestPermission = async () => {
    if (!("Notification" in window)) {
      setPermission("unsupported");
      return;
    }

    setRequestState("requesting");
    const permissionRequest = Notification.requestPermission();
    permissionRequest
      .then((nextPermission) => {
        setPermission(nextPermission);
        setRequestState(nextPermission === "default" ? "requested" : "idle");
      })
      .catch(() => {
        setPermission(Notification.permission);
        setRequestState("error");
      });

    try {
      const nextPermission = await Promise.race([permissionRequest, notificationPermissionTimeout()]);
      setPermission(nextPermission);
      setRequestState(nextPermission === "default" ? "requested" : "idle");
    } catch {
      setPermission(Notification.permission);
      setRequestState("error");
    }
  };

  const statusText =
    requestState === "requesting"
      ? "requesting"
      : requestState === "requested" && permission === "default"
        ? "request sent"
        : requestState === "error"
          ? "request failed"
          : permission;

  return (
    <section className="push-panel" aria-label="Web Push">
      <div className="flex items-start gap-3">
        <div className="push-icon">{isSupported ? <Bell size={18} /> : <BellOff size={18} />}</div>
        <div className="min-w-0 flex-1">
          <h2 className="panel-title">Web Push</h2>
          <p className="mt-1 text-sm text-ink-600">Browser notifications for approval and runner status changes.</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="rounded bg-ink-100 px-2 py-1 text-xs font-medium text-ink-700">{statusText}</span>
            <button
              className="small-button"
              type="button"
              disabled={!isSupported || permission === "granted" || requestState === "requesting"}
              onClick={() => void requestPermission()}
            >
              {requestState === "requesting" ? "Requesting" : permission === "default" ? "Enable" : "Retry"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function notificationPermissionTimeout(): Promise<NotificationPermission> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(Notification.permission), 1500);
  });
}
