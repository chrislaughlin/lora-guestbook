import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { PublicGuestMessage } from "./guest-message";

type Listener = (event: Event) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CLOSED = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  url: string;
  readyState = MockEventSource.CONNECTING;
  closed = false;

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
    MockEventSource.instances = MockEventSource.instances.filter((instance) => instance !== this);
  }

  emitOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.dispatch("open", new Event("open"));
  }

  emitMessage(data: unknown): void {
    this.dispatch("guest-message", new MessageEvent("guest-message", { data: JSON.stringify(data) }));
  }

  emitError(): void {
    this.readyState = MockEventSource.CONNECTING;
    this.dispatch("error", new Event("error"));
  }

  private dispatch(type: string, event: Event): void {
    const set = this.listeners.get(type);
    if (set === undefined) {
      return;
    }
    for (const listener of [...set]) {
      listener(event);
    }
  }
}

const messagesFixture: PublicGuestMessage[] = [
  {
    id: 2,
    name: "Ada Lovelace",
    message: "Hello from the radio desk",
    receivedAt: "2026-08-31T10:15:00.000Z",
    storedAt: "2026-08-31T10:15:01.000Z"
  },
  {
    id: 1,
    name: "Grace Hopper",
    message: "Testing, one two three",
    receivedAt: "2026-08-31T10:14:00.000Z",
    storedAt: "2026-08-31T10:14:01.000Z"
  }
];

function fetchOk(messages: PublicGuestMessage[]): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { messages };
    }
  }));
}

function installMockEventSource(): void {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  MockEventSource.instances = [];
});

describe("App", () => {
  beforeEach(() => {
    installMockEventSource();
  });

  it("shows a loading state while messages are being fetched", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          })
      )
    );

    render(<App />);
    expect(screen.getByText("Loading guestbook...")).toBeInTheDocument();

    resolveFetch({ ok: true, status: 200, json: async () => ({ messages: [] }) });
    await waitFor(() => expect(screen.queryByText("Loading guestbook...")).not.toBeInTheDocument());
  });

  it("shows a clear empty state when there are no entries", async () => {
    vi.stubGlobal("fetch", fetchOk([]));

    render(<App />);
    await screen.findByText("No guestbook messages yet. New entries appear live.");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders persisted entries newest-first", async () => {
    vi.stubGlobal("fetch", fetchOk(messagesFixture));

    render(<App />);
    const list = await screen.findByRole("list");
    const entries = within(list).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("@AdaLovelace");
    expect(entries[0]).toHaveTextContent("10:15 UTC");
    expect(entries[1]).toHaveTextContent("@GraceHopper");
  });

  it("renders newest-first by receivedAt even when id order does not correlate (late-arriving older id renders below newer receivedAt)", async () => {
    // id and receivedAt orders diverge: the highest id (3) has the OLDEST
    // receivedAt. An id-only sort would wrongly place it on top (CQ-1); the
    // documented server comparator must sort by receivedAt new, then id as a
    // tie-breaker, so the older record renders below the newer ones.
    const diverging: PublicGuestMessage[] = [
      {
        id: 1,
        name: "Middle entry",
        message: "Received second",
        receivedAt: "2026-08-31T10:15:00.000Z",
        storedAt: "2026-08-31T10:15:01.000Z"
      },
      {
        id: 3,
        name: "Late-arriving older packet",
        message: "Oldest on the wire but highest id",
        receivedAt: "2026-08-31T10:14:00.000Z",
        storedAt: "2026-08-31T10:14:01.000Z"
      },
      {
        id: 2,
        name: "Newest entry",
        message: "Received first, newest receivedAt",
        receivedAt: "2026-08-31T10:16:00.000Z",
        storedAt: "2026-08-31T10:16:01.000Z"
      }
    ];
    vi.stubGlobal("fetch", fetchOk(diverging));

    render(<App />);
    const list = await screen.findByRole("list");
    const entries = within(list).getAllByRole("listitem");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent("@Newestentry");
    expect(entries[1]).toHaveTextContent("@Middleentry");
    expect(entries[2]).toHaveTextContent("@Latearrivingolderpacket");
  });

  it("shows an error state with a Retry button on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    render(<App />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("recovers after a failed fetch via the Retry button", async () => {
    let shouldFail = true;
    const fetchMock = vi.fn(async () => {
      if (shouldFail) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ messages: messagesFixture }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("alert");

    shouldFail = false;
    screen.getByRole("button", { name: "Retry" }).click();
    await screen.findByText("@AdaLovelace");
  });

  it("adds exactly one new entry from a live SSE event without full refresh", async () => {
    vi.stubGlobal("fetch", fetchOk(messagesFixture));

    render(<App />);
    await screen.findByText("@AdaLovelace");

    const source = MockEventSource.instances[0];
    if (source === undefined) {
      throw new Error("Expected an EventSource instance.");
    }
    source.emitOpen();
    source.emitMessage({
      id: 3,
      name: "Katherine Johnson",
      message: "Live and counting",
      receivedAt: "2026-08-31T10:16:00.000Z",
      storedAt: "2026-08-31T10:16:01.000Z"
    });

    await screen.findByText("@KatherineJohnson");
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getAllByText("@KatherineJohnson")).toHaveLength(1);
  });

  it("does not duplicate an entry whose id overlaps the initial list", async () => {
    vi.stubGlobal("fetch", fetchOk(messagesFixture));

    render(<App />);
    await screen.findByText("@AdaLovelace");

    const source = MockEventSource.instances[0];
    if (source === undefined) {
      throw new Error("Expected an EventSource instance.");
    }
    source.emitOpen();
    source.emitMessage(messagesFixture[0]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByText("@AdaLovelace")).toHaveLength(1);
  });

  it("renders HTML-like content as escaped literal text (no element injected)", async () => {
    const malicious: PublicGuestMessage[] = [
      {
        id: 1,
        name: '<script>window.__pwned = true</script>',
        message: "<b>bold</b><img src=x onerror=alert(1)>",
        receivedAt: "2026-08-31T10:14:00.000Z",
        storedAt: "2026-08-31T10:14:01.000Z"
      }
    ];
    vi.stubGlobal("fetch", fetchOk(malicious));

    render(<App />);
    await screen.findByRole("list");

    expect(screen.getByText(/scriptwindowpwnedtruescript/)).toBeInTheDocument();
    expect(screen.getByText(/<b>bold<\/b>/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("surfaces a recoverable reconnect state when the live stream drops and restores live on reconnect", async () => {
    vi.stubGlobal("fetch", fetchOk(messagesFixture));

    render(<App />);
    await screen.findByText("@AdaLovelace");

    const source = MockEventSource.instances[0];
    if (source === undefined) {
      throw new Error("Expected an EventSource instance.");
    }
    source.emitOpen();
    await screen.findByText("Live");

    // Stream becomes unavailable: reconnect state is surfaced to the user.
    source.emitError();
    await screen.findByText(/Reconnecting.../);
    expect(screen.getByText("@AdaLovelace")).toBeInTheDocument();

    // EventSource auto-reconnects: live state is restored without affecting entries.
    source.emitOpen();
    await screen.findByText("Live");
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("re-fetches and merges without duplicates when the stream reconnects", async () => {
    const liveKatherine: PublicGuestMessage = {
      id: 3,
      name: "Katherine Johnson",
      message: "Live and counting",
      receivedAt: "2026-08-31T10:16:00.000Z",
      storedAt: "2026-08-31T10:16:01.000Z"
    };
    let includeLiveRecord = false;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          messages: includeLiveRecord
            ? [liveKatherine, ...messagesFixture]
            : messagesFixture
        };
      }
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByText("@AdaLovelace");

    const source = MockEventSource.instances[0];
    if (source === undefined) {
      throw new Error("Expected an EventSource instance.");
    }
    source.emitOpen();

    // A live entry arrives while connected and is only present once.
    source.emitMessage(liveKatherine);
    await screen.findByText("@KatherineJohnson");

    // The stream drops and, meanwhile, the entry is persisted server-side.
    includeLiveRecord = true;
    source.emitError();
    await screen.findByText(/Reconnecting.../);

    // Reconnect triggers a re-fetch + merge; the overlapping id must not duplicate.
    source.emitOpen();

    await waitFor(() => {
      const list = screen.getByRole("list");
      const entries = within(list).getAllByRole("listitem");
      expect(entries).toHaveLength(3);
      expect(within(list).getAllByText("@KatherineJohnson")).toHaveLength(1);
      expect(within(list).getAllByText("@AdaLovelace")).toHaveLength(1);
      expect(entries[0]).toHaveTextContent("@KatherineJohnson");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the Retry button keyboard-reachable in the error state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    render(<App />);
    await screen.findByRole("alert");

    const retry = screen.getByRole("button", { name: "Retry" });
    // A native button, so it is a real interactive control in the default tab order.
    expect(retry.tagName).toBe("BUTTON");
    expect(retry.tabIndex).toBe(0);
    retry.focus();
    expect(retry).toHaveFocus();
  });
});
