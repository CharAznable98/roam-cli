export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("Unable to register RoamCli service worker", error);
    });
  });
}

export function getNotificationSupport(): "granted" | "denied" | "default" | "unsupported" {
  if (!("Notification" in window)) {
    return "unsupported";
  }

  return Notification.permission;
}
