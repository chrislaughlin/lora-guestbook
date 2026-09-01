import type { PublicGuestMessage } from "./guest-message.js";
import { useGuestMessages } from "./useGuestMessages.js";

export default function App(): React.JSX.Element {
  const { errorMessage, liveConnected, messages, ready, retry } = useGuestMessages();

  return (
    <main className="app">
      <header className="app-header">
        <h1>Radio Guestbook</h1>
        <p className="app-description">
          Messages arriving live over the radio, newest first. This public page updates as new entries arrive.
        </p>
        <p
          className="live-status"
          role="status"
          aria-live={liveConnected ? "off" : "assertive"}
        >
          {liveConnected ? "● Live" : "● Reconnecting…"}
        </p>
      </header>

      <section aria-label="Guestbook">
        {!ready && errorMessage === null && (
          <p className="state-message">Loading guestbook…</p>
        )}

        {!ready && errorMessage !== null && (
          <div className="error-state" role="alert">
            <p>{errorMessage}</p>
            {!liveConnected && (
              <p className="state-message">Live updates are temporarily unavailable. Reconnecting…</p>
            )}
            <button type="button" onClick={retry}>
              Retry
            </button>
          </div>
        )}

        {ready && messages.length === 0 && (
          <p className="state-message">No guestbook messages yet. Check back soon – new entries appear live.</p>
        )}

        {ready && messages.length > 0 && (
          <ul className="guestbook-list" aria-live="polite">
            {messages.map((message) => (
              <GuestEntry key={message.id} message={message} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function GuestEntry({ message }: { message: PublicGuestMessage }): React.JSX.Element {
  return (
    <li className="guest-entry">
      <p className="guest-name">{message.name}</p>
      <p className="guest-message">{message.message}</p>
    </li>
  );
}
