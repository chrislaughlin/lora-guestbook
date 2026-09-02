import { useEffect, useRef, useState } from "react";

import type { PublicGuestMessage } from "./guest-message.js";

export interface GuestMessageEventSource extends EventSource {
  readyState: number;
}

export interface UseGuestMessagesResult {
  errorMessage: string | null;
  liveConnected: boolean;
  messages: PublicGuestMessage[];
  ready: boolean;
  retry: () => void;
}

const SSE_EVENT_NAME = "guest-message";

interface ListResponse {
  messages: PublicGuestMessage[];
}

function isPublicGuestMessage(value: unknown): value is PublicGuestMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "number" &&
    typeof candidate.name === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.receivedAt === "string" &&
    typeof candidate.storedAt === "string"
  );
}

export function useGuestMessages(
  createEventSource: (url: string) => GuestMessageEventSource = (url) => new EventSource(url)
): UseGuestMessagesResult {
  const [messages, setMessages] = useState<PublicGuestMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);

  const eventSourceRef = useRef<GuestMessageEventSource | null>(null);
  const createEventSourceRef = useRef(createEventSource);
  createEventSourceRef.current = createEventSource;
  const loadedOnceRef = useRef(false);

  const mergeAndSort = (current: PublicGuestMessage[], incoming: PublicGuestMessage[]) => {
    const byId = new Map<number, PublicGuestMessage>();
    for (const message of incoming) {
      byId.set(message.id, message);
    }
    for (const message of current) {
      if (!byId.has(message.id)) {
        byId.set(message.id, message);
      }
    }
    return [...byId.values()].sort(
      (a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id - a.id
    );
  };

  const reconcileRef = useRef<() => Promise<void>>(async () => {});
  const reconcile = async () => {
    try {
      const response = await fetch("/api/guest-messages");
      if (!response.ok) {
        throw new Error(`Request failed with status ${String(response.status)}.`);
      }
      const body = (await response.json()) as ListResponse;
      if (!Array.isArray(body.messages)) {
        throw new Error("Guestbook response was malformed.");
      }
      const fetched = body.messages.filter(isPublicGuestMessage);
      setMessages((current) => mergeAndSort(current, fetched));
      loadedOnceRef.current = true;
      setReady(true);
      setErrorMessage(null);
    } catch {
      setErrorMessage("Could not load guestbook messages.");
      if (!loadedOnceRef.current) {
        setReady(false);
      }
    }
  };
  reconcileRef.current = reconcile;

  const retry = () => {
    setErrorMessage(null);
    setReady(false);
    void reconcileRef.current();
  };

  useEffect(() => {
    let disposed = false;
    let source: GuestMessageEventSource | null = null;

    const openEvents = () => {
      if (disposed) {
        return;
      }

      const es = createEventSourceRef.current("/api/guest-messages/events");
      eventSourceRef.current = es;

      es.addEventListener(SSE_EVENT_NAME, (event: MessageEvent) => {
        try {
          const parsed = JSON.parse(String(event.data)) as unknown;
          if (!isPublicGuestMessage(parsed)) {
            return;
          }
          setMessages((current) => {
            if (current.some((message) => message.id === parsed.id)) {
              return current;
            }
            return [parsed, ...current].sort(
              (a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.id - a.id
            );
          });
          loadedOnceRef.current = true;
          setReady(true);
          setErrorMessage(null);
        } catch {
          // Ignore malformed event payloads.
        }
      });

      es.addEventListener("open", () => {
        if (disposed) {
          return;
        }
        // Reconcile on every open: the first open re-fetches after the
        // client is subscribed server-side (closing the window where an
        // accepted message would otherwise be missed by both the initial
        // list snapshot and the stream), and later opens re-fetch to recover
        // records published during a disconnect gap.
        void reconcileRef.current();
        setLiveConnected(true);
      });

      es.addEventListener("error", () => {
        if (disposed) {
          return;
        }
        // EventSource auto-reconnects in CONNECTING state; surface reconnect
        // state so the UI can indicate recovery.
        setLiveConnected(false);
        setErrorMessage("Live updates are temporarily unavailable. Reconnecting…");
      });

      source = es;
    };

    openEvents();
    void reconcileRef.current();

    return () => {
      disposed = true;
      source?.close();
      eventSourceRef.current = null;
    };
  }, []);

  return {
    errorMessage,
    liveConnected,
    messages,
    ready,
    retry
  };
}
