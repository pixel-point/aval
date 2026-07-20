# Accessibility

`<aval-player>` is a visual primitive. It does not add a role, name,
`tabindex`, keyboard handler, live region, pressed state, navigation, or
business action.

```html
<button id="favorite" type="button" aria-pressed="false">
  <aval-player
    interaction-for="favorite"
    aria-hidden="true"
  >
    <source
      src="favorite.h264.avl"
      type='application/vnd.aval; codecs="avc1.42E01E"'
    >
  </aval-player>
  <img id="favorite-unavailable" src="favorite.png" alt="" hidden>
  <span>Favorite</span>
</button>
```

Keep meaning in text/ARIA owned by the page. Use an independent live region for
loading or errors. Static reduced-motion states must communicate the same
meaning as animated states. Supply a separate pause control when nonessential
motion continues beyond five seconds. Avoid rapid flashes, excessive parallax,
and high-frequency infinite motion even when full motion is requested.

If the application chooses to reveal alternate content after a fatal `error`,
it also owns that content's accessible name, visibility, and status messaging.
