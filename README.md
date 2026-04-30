# CTFd Live Attack Map

This plugin adds a live attack map page at `/livemap` and a site-wide first-blood toast for CTFd.

Live updates are event-driven through SSE, so there is no polling interval to tune.

## Do You Need `npm build`?

No, not for this plugin.

This plugin ships as:

- `__init__.py`
- `templates/livemap.html`
- `static/livemap.js`
- `static/livemap.css`
- `static/sounds/firstblood.mp3`

CTFd serves those files directly from the plugin folder, so there is no Vite, Webpack, or npm build step required for the plugin itself.

What you do need:

- restart the CTFd app after changing Python files such as `__init__.py`
- hard refresh the browser after changing static files like JS, CSS, or audio

You only need a theme build if you separately edit a theme’s own `assets/` source files. This plugin does not require theme changes.

## Features

- Adds a `/livemap` page rendered through the active CTFd theme layout
- Shows top 10 teams or users on the left side
- Shows challenges on the right side
- Animates solve beams from account nodes to challenge nodes
- Highlights first blood with a gold beam
- Plays `firstblood.mp3` on first blood
- Shows a centered first-blood toast on every page, not just `/livemap`
- Adds a `Live Map` entry to the user plugin menu
- Falls back to `Challenge #<id>` labels if the challenge listing API is not available to the current viewer
- Supports drag-to-pan, wheel scrolling, and zoom controls on the live map canvas

## Files

```text
live-attack-map/
├── __init__.py
├── config.json
├── README.md
├── static/
│   ├── livemap.css
│   ├── livemap.js
│   └── sounds/
│       └── firstblood.mp3
└── templates/
    └── livemap.html
```

## Installation

1. Place this folder in `CTFd/plugins/live-attack-map`.
2. Make sure the sound file exists at `CTFd/plugins/live-attack-map/static/sounds/firstblood.mp3`.
3. Restart CTFd so the plugin loader imports `__init__.py`.
4. Open `/livemap`.

## How It Works

### Backend

The plugin registers:

- a Flask blueprint route at `/livemap`
- a plugin stylesheet
- a plugin script
- a plugin menu entry named `Live Map`

### Frontend

The frontend script does two jobs:

1. It runs a shared live-update store on every page.
2. It initializes the `LiveMap` Alpine component when the `/livemap` page is present.

On `/livemap`, the template also injects `livemap.js` before the theme's normal page script so the `LiveMap` Alpine component is registered before the theme calls `Alpine.start()`.

The shared store is responsible for:

- loading scoreboard and challenge data on first paint
- refreshing solve data on SSE update events
- verifying first bloods through the challenge solves endpoint when available
- showing the site-wide first-blood toast and audio

The page component is responsible for:

- sizing the canvas
- laying out team/user and challenge nodes
- animating node movement when rankings change
- drawing solve beams and first-blood effects
- handling drag, scroll, and zoom interactions on the canvas

## Map Controls

- Drag on the canvas to pan the map
- Scroll to move the viewport
- Hold `Ctrl` or `Cmd` while scrolling to zoom toward the cursor
- Use the on-screen `-`, `+`, and `Reset` controls in the top-right corner of the map

## Live Update Behavior

- The client performs one initial load for scoreboard, challenges, and solve feed data
- Live updates arrive via `/api/v1/events` Server-Sent Events
- Solve refreshes use `GET /api/v1/scoreboard/top/50` when update events arrive
- Full challenge metadata is requested when available, but the map can still render from solve-feed data if that endpoint is restricted

## API Endpoints Used

- `GET /api/v1/scoreboard`
- `GET /api/v1/challenges`
- `GET /api/v1/challenges/<challenge_id>`
- `GET /api/v1/scoreboard/top/50`
- `GET /api/v1/challenges/<challenge_id>/solves`
- `GET /api/v1/teams/<account_id>` / `GET /api/v1/users/<account_id>`
- `GET /api/v1/events`

The plugin can still draw nodes and beams if `GET /api/v1/challenges` is unavailable, but challenge names and confirmed first-blood behavior depend on challenge API access.

## First Blood Logic

First blood is not guessed only from the current top-10 snapshot.

When a new solve appears:

- the client refreshes solve data when an update event arrives
- the backend publishes a `livemap_fb` event to the SSE stream for first blood
- the client confirms first bloods with `GET /api/v1/challenges/<challenge_id>/solves` when needed

This helps avoid false positives when the first solver was not visible in the current top list.

If the current viewer cannot access the challenge endpoints, the map still updates from scoreboard data, but first-blood confirmation and toast triggering may not be available for that session.

## Notes And Caveats

- The map page shows only the top 10 teams or users as nodes.
- Solve detection refreshes the top 50 scoreboard detail feed on SSE update events.
- If a first blood happened before a browser opened the site, it will still be marked on the map, but the toast only appears for newly detected events in that browser session.
- Browser autoplay rules can block sound until the user has interacted with the page. The toast will still appear.
- The plugin assumes the active theme exposes `window.Alpine` and `window.CTFd`, which matches standard CTFd themes.
- Some CTFd setups protect `/api/v1/challenges` and `/api/v1/challenges/<id>/solves` behind login or verification.
- In those protected setups, anonymous viewers can still see the map render from scoreboard data, but they may see fallback challenge labels and may not receive confirmed first-blood toasts.

## Updating The Plugin

If you change:

- `__init__.py`: restart CTFd
- `static/livemap.js` or `static/livemap.css`: hard refresh the browser
- `templates/livemap.html`: restart CTFd or clear template cache, then hard refresh the browser

## Troubleshooting

- If `/livemap` loads but the badges stay blank or no nodes appear, do a hard refresh first so the browser picks up the latest `livemap.js`.
- If it is still blank after a hard refresh, restart CTFd once so template and plugin state are reloaded cleanly.
- If challenge nodes appear as `Challenge #<id>`, the viewer likely cannot access `GET /api/v1/challenges`; this is expected fallback behavior.
- If first-blood beams appear but no toast fires, the viewer likely cannot access the challenge solve-confirmation endpoint needed to prove first blood.

## Quick Verification

After installation, verify:

1. `/livemap` loads without a 404
2. `Live Map` appears in the plugin/user menu
3. the browser loads:
   - `/plugins/live-attack-map/static/livemap.js`
   - `/plugins/live-attack-map/static/livemap.css`
   - `/plugins/live-attack-map/static/sounds/firstblood.mp3`
4. the signal badges populate with mode, node count, active beams, and last update time
5. new solves animate on the map within a few seconds
6. dragging, scrolling, and zoom controls move the map as expected
7. a new first blood shows the gold toast and tries to play audio when the viewer has challenge API access
