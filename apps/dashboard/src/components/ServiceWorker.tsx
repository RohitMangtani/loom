"use client";

import { useEffect, useCallback, useState } from "react";
import type { DaemonMessage } from "@/lib/types";

export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}

export type PushState = "unsupported" | "prompt" | "subscribed" | "denied";

/**
 * Hook for Web Push subscription.
 * Returns pushState and a requestPush() function that MUST be called from a user gesture (tap).
 * iOS PWAs require user-initiated events for Notification.requestPermission().
 */
export function usePushSubscription(
  send: (msg: DaemonMessage) => boolean,
  vapidKey: string | null,
): { pushState: PushState; requestPush: () => void } {
  const [pushState, setPushState] = useState<PushState>("unsupported");

  // Detect initial state
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushState("denied");
      return;
    }
    // Check if already subscribed
    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        if (sub) {
          setPushState("subscribed");
          // Re-send subscription to daemon (survives daemon restart)
          if (vapidKey) {
            const json = sub.toJSON();
            if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
              send({
                type: "push_subscribe",
                subscription: {
                  endpoint: json.endpoint,
                  keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
                },
                pushLabel: getDeviceLabel(),
              });
            }
          }
        } else {
          setPushState("prompt");
        }
      });
    }).catch(() => {});
  }, [vapidKey, send]);

  // Must be called from a user gesture (click/tap)  --  iOS requirement
  const requestPush = useCallback(async () => {
    if (!vapidKey || !("serviceWorker" in navigator) || !("PushManager" in window)) return;

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState("denied");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const keyBytes = urlBase64ToUint8Array(vapidKey);

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes.buffer as ArrayBuffer,
      });

      const sub = subscription.toJSON();
      if (sub.endpoint && sub.keys?.p256dh && sub.keys?.auth) {
        send({
          type: "push_subscribe",
          subscription: {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          },
          pushLabel: getDeviceLabel(),
        });
        setPushState("subscribed");
      }
    } catch (err) {
      console.log("[push] Subscription failed:", err);
      setPushState("denied");
    }
  }, [vapidKey, send]);

  return { pushState, requestPush };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

function getDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  return "Browser";
}
