# Accessibility and motion

The custom element supplies motion, not business semantics. Put button, link,
pressed, selected, status, progress, and keyboard behavior on ordinary host DOM
where users and assistive technology expect it. Use `interaction-for` or the
`interactionTarget` property to associate that semantic control with motion.

`motion="auto"` follows live `prefers-reduced-motion`; `reduce` leaves the
host-owned fallback slot visible; `full` requests animation when exact
capabilities and resources permit it. Reduced motion still processes authored
state changes and bindings, but an infinite body does not advance. The host
fallback must convey an acceptable non-animated meaning.

A player embedding the runtime directly can also set `turnPolicy: "direct"`, so a
multi-step request along a [ring](./project/1.0.md#rings-and-turn-edges) lands in
its target without playing the intermediate states. One `turnstep` still reports
the final landing, which keeps a host's ring bookkeeping identical under either
policy. `chain` is the default and the only policy that preserves frame
continuity across the whole arc.

Light-DOM fallback remains usable without JavaScript. Supply meaningful
alternative text when motion carries information, and empty alternative text
when it is decorative. The element does not capture keyboard events, suppress
clicks, or invent roles.
