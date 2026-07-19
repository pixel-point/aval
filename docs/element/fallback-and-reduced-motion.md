# Failure handling and reduced motion

AVAL owns playback but not alternate presentation. It creates no fallback slot,
does not generate a poster, and never reveals or hides consumer DOM. A terminal
capability or playback failure rejects `prepare()` with `AvalPlaybackError` and
raises one fatal `error` event. The application can respond with an image,
another animation technology, text, an empty state, or nothing.

`motion="auto"` follows live `prefers-reduced-motion`; `reduce` does not decode
or advance animation, and `full` ignores that preference while still respecting
visibility, pause intent, and resource limits. Reduced motion and visibility
suspension are nonfatal policy states. They do not imply that AVAL supplied a
static visual. If a fresh source first becomes animated after an initial hidden
or reduced preparation, it begins at intro frame zero. Once that intro has
reached the body, later reduced-to-full or visibility re-entry begins the
current state's body at frame zero without replaying the intro.
If visibility or motion policy interrupts the intro before that join, the next
eligible activation restarts it at frame zero. An explicit programmatic state
commit in static mode can instead move away from the initial state and waive
the intro; automatic inputs remain gated until the runtime is visible.

Offscreen, document-hidden, page-hidden, and zero-size hosts suspend through
the same player visibility path. Logical time freezes. Re-entry rebuilds behind
the retained AVAL canvas without elapsed-time catch-up. `pause()` is independent
of visibility; `resume()` records intent even while hidden. The application may
independently choose different UI for reduced motion, but AVAL does not make
that policy decision.
