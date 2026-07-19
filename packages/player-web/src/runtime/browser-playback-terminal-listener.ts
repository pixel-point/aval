import type { RuntimePlaybackError } from "./errors.js";
import type {
  IntegratedPlaybackSession
} from "./integrated-player-contracts.js";

export type BrowserPlaybackTerminalListener = (
  error: RuntimePlaybackError
) => void;

/** Internal capability used only by browser-backed playback sessions. */
export const BROWSER_PLAYBACK_TERMINAL_LISTENER: unique symbol = Symbol(
  "browser-playback-terminal-listener"
);

export interface BrowserPlaybackTerminalSource {
  [BROWSER_PLAYBACK_TERMINAL_LISTENER](
    listener: BrowserPlaybackTerminalListener
  ): () => void;
}

/** Subscribe when the playback delegate exposes the browser terminal seam. */
export function listenForBrowserPlaybackTerminal(
  playback: IntegratedPlaybackSession,
  listener: BrowserPlaybackTerminalListener
): () => void {
  const source = playback as IntegratedPlaybackSession &
    Partial<BrowserPlaybackTerminalSource>;
  const subscribe = source[BROWSER_PLAYBACK_TERMINAL_LISTENER];
  return typeof subscribe === "function"
    ? subscribe.call(source, listener)
    : () => undefined;
}
