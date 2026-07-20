# Accessibility and motion

The custom element supplies motion, not business semantics. Put button, link,
pressed, selected, status, progress, and keyboard behavior on ordinary host DOM
where users and assistive technology expect it. Use `interaction-for` or the
`interactionTarget` property to associate that semantic control with motion.

`motion="auto"` follows live `prefers-reduced-motion`; `reduce` prevents active
animation; `full` requests animation when exact capabilities and resources
permit it. Reduced motion remains a nonfatal policy condition. AVAL does not
choose what alternate visual, if any, the application should present.

Consumer-owned HTML remains usable without JavaScript. If the application
reveals an image after `AvalPlaybackError`, supply meaningful alternative text
when motion carries information and empty alternative text when it is
decorative. The element does not capture keyboard events, suppress clicks, or
invent roles.
