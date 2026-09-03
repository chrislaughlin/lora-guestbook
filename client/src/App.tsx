import type { PublicGuestMessage } from "./guest-message.js";
import { useGuestMessages } from "./useGuestMessages.js";

interface FloatingMessageStyle extends React.CSSProperties {
  "--float-delay": string;
  "--float-x-duration": string;
  "--float-y-duration": string;
  "--hue": string;
  "--start-x": string;
  "--start-y": string;
}

const MESSAGE_PALETTE = [
  "oklch(62% 0.18 289)",
  "oklch(67% 0.15 224)",
  "oklch(66% 0.17 337)",
  "oklch(70% 0.13 253)",
  "oklch(64% 0.16 312)"
] as const;

export default function App(): React.JSX.Element {
  const { errorMessage, liveConnected, messages, ready, retry } = useGuestMessages();

  return (
    <main className="app">
      <div className="signal-backdrop" aria-hidden="true" />

      <header className="app-header" aria-label="Radio Guestbook status">
        <div>
          <p className="app-kicker">LoRa public relay</p>
          <h1>Radio Guestbook</h1>
        </div>
        <p
          className="live-status"
          role="status"
          aria-live={liveConnected ? "off" : "assertive"}
        >
          <span className="status-light" aria-hidden="true" />
          {liveConnected ? "Live" : "Reconnecting..."}
        </p>
      </header>

      <section className="guestbook-display" aria-label="Guestbook">
        {!ready && errorMessage === null && (
          <p className="state-message">Loading guestbook...</p>
        )}

        {!ready && errorMessage !== null && (
          <div className="error-state" role="alert">
            <p>{errorMessage}</p>
            {!liveConnected && (
              <p className="state-message">Live updates are temporarily unavailable. Reconnecting...</p>
            )}
            <button type="button" onClick={retry}>
              Retry
            </button>
          </div>
        )}

        {ready && messages.length === 0 && (
          <p className="state-message">No guestbook messages yet. New entries appear live.</p>
        )}

        {ready && messages.length > 0 && (
          <ul className="guestbook-list" aria-live="polite">
            {messages.map((message, index) => (
              <GuestEntry
                key={message.id}
                index={index}
                message={message}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function GuestEntry({ index, message }: { index: number; message: PublicGuestMessage }): React.JSX.Element {
  const style = floatingStyle(index);

  return (
    <li className="guest-entry" style={style}>
      <p className="guest-name">@{handleFromName(message.name)}</p>
      <p className="guest-message">{message.message}</p>
      <time className="guest-time" dateTime={message.receivedAt}>
        {formatUtcTime(message.receivedAt)}
      </time>
    </li>
  );
}

function floatingStyle(index: number): FloatingMessageStyle {
  const xSlots = [6, 35, 63, 18, 52, 74, 28, 9];
  const ySlots = [24, 42, 29, 64, 58, 18, 73, 50];

  return {
    "--float-delay": `${String(index * -7)}s`,
    "--float-x-duration": `${String(58 + (index % 5) * 11)}s`,
    "--float-y-duration": `${String(67 + (index % 4) * 13)}s`,
    "--hue": MESSAGE_PALETTE[index % MESSAGE_PALETTE.length] ?? MESSAGE_PALETTE[0],
    "--start-x": `${String(xSlots[index % xSlots.length])}%`,
    "--start-y": `${String(ySlots[index % ySlots.length])}%`
  };
}

function handleFromName(name: string): string {
  const compact = name.replace(/[^a-zA-Z0-9]+/g, "");
  return compact.length > 0 ? compact : "Guest";
}

function formatUtcTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return `${date.toISOString().slice(11, 16)} UTC`;
}
