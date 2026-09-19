# tests/perf - CDP performance and behaviour harness

Drives a **production build** of `DesktopPet` in real Chrome over the DevTools
Protocol. No dependencies: Node 22+ ships a global `WebSocket` and macOS ships
Chrome.

    cd client
    npx vite build --config vite.config.perf.js
    node tests/perf/characterise.mjs

## Why this exists alongside tests/visual

`tests/visual` makes SCREENSHOTS deterministic, and to do that it disables CSS
transitions, stubs `cancelAnimationFrame`, pins the clock, replaces
`requestAnimationFrame` with a budgeted queue, and runs the dev server. Every
one of those is a mechanism this harness has to observe rather than suppress:
the creature's 3 s glide home and the pupils' 0.1 s eye easing ARE the behaviour
under test, and pointer work is scheduled in rAF. `tests/visual` also dispatches
no pointer input at all.

Use `tests/visual` for "did the appearance change". Use this for "what does the
creature do when you drag it, and what does that cost".

## Files

- `harness.html` / `harness.jsx` - mounts `DesktopPet` with no auth, and exposes
  `window.__perf`: `creature()` (DOM plus store state together), `eyes()` (the
  four eye nodes, found by position in BOTH axes because body spots sit near the
  same `cx`), `bubble()`, and `countStart()` / `countStop()` for store snapshot
  churn.
- `cdp.mjs` - CDP client, static server, Chrome launcher, `movePath` for
  dispatching pointer paths at a controlled rate. Refuses to attach to a Chrome
  left over from a crashed run rather than silently reusing it.
- `characterise.mjs` - reports current behaviour; it is the instrument, not a
  gate. Written to replace behaviour claims sourced from code comments.

## Known limits

- The harness window cannot exceed ~31 fps on this machine even for a blank
  page, so frame-rate figures are not meaningful here; main-thread cost is.
- CDP-dispatched pointer moves are not aligned to rAF the way real Chrome input
  is, so event-rate-derived numbers are an upper bound.
