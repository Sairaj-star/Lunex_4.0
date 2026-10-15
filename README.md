# LUNEX

LUNEX is a responsive private lounge app with Three.js visuals, private suite keys, live suite chat, media sharing, shared video playback, Tic-Tac-Toe, a shared link shelf, suite notes, and an owner command center.

## Run locally

Requirements: Node.js 20 or newer.

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and set `OWNER_PASSWORD` and a random `SESSION_SECRET` of at least 32 characters.
3. Run `npm start`.
4. Open `http://localhost:3000`.

The app creates exactly 500 suites. Local records are saved to `data/lunex.json`; uploaded files are saved under `data/uploads`. The store creates itself on first run. Never use the built-in local development secret in a deployment.

The booking form requests a display name, ten-digit number, and capacity. The number is booking information only and is not verified. A successful booking returns the suite key once; keep it private. The room key is the only guest entry method.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (defaults to 3000) |
| `OWNER_USERNAME` | Owner login name (defaults to `owner`) |
| `OWNER_PASSWORD` | Required server-side owner password |
| `SESSION_SECRET` | Random secret used for suite-key digests, sessions, and vault encryption |
| `PUBLIC_ORIGIN` | Optional allowed Socket.IO origin; same-origin requests work without it |
| `DATA_FILE` | Persistent JSON data file path (defaults to `./data/lunex.json`) |

Use a different long random `SESSION_SECRET` per installation. Changing it makes saved vault notes unreadable and invalidates stored suite-key digests. Make a protected backup before rotating it. Vault records use AES-256-GCM with a per-record random salt and IV and a key derived from `SESSION_SECRET` using scrypt. This is encryption at rest, not end-to-end encryption. The server can read the notes while a suite is active.

## Features

- 500 backend-managed suites; randomly generated keys, capacity checks, and key entry.
- Responsive lounge with a Three.js animated orb/ring scene and a reduced-motion fallback.
- Socket.IO chat with safe text rendering, sender-owned edit/delete, reconnect handling, and server-side message rate limits.
- Image, video, and audio file sharing up to 15 MB with MIME signature checks and suite-authorized retrieval.
- Cinema support for YouTube IFrame Player API and direct MP4/WebM URLs, including shared load/play/pause/seek updates.
- Server-validated Tic-Tac-Toe, shared links, and encrypted-at-rest suite notes.
- Owner login configured through environment variables; owner stats and suite reset controls.
- LUNA built-in help for keys, privacy, connection issues, Cinema, Arcade, and Library.
- After Dark appearance preference stored in the browser.

## Current scope and deployment limits

This build uses a local JSON repository and one Node process. It does not include PostgreSQL, a Socket.IO multi-instance adapter, automated backups, SMS verification, a voice-note recorder, cross-device profiles/preferences, or an externally reviewed cryptographic design. These are not implied to be provided. A suite stays reserved until the owner resets it if nobody enters; automatic booking expiry is not implemented. A persistent disk is required for hosted bookings and uploads; ephemeral host storage will lose them on restart. Uploaded file retention and cleanup are not automated. Room notes and messages are shared with the people currently in the suite. Don't enter highly sensitive information.

Cinema synchronization sends meaningful playback events. YouTube or direct-media availability depends on the source owner's embed permissions, the browser's codecs, CORS, and autoplay policy. LUNEX does not bypass DRM or source restrictions. A browser may ask each guest to press Play.

## Render deployment

1. Push this project to a private or public GitHub repository.
2. Create a Render Web Service from the repository.
3. Set the runtime to Node.js 22, build command to `npm ci`, and start command to `npm start`.
4. Add a persistent disk mounted at `/var/data`.
5. Set `DATA_FILE=/var/data/lunex.json`, `OWNER_USERNAME`, a long unique `OWNER_PASSWORD`, and a random `SESSION_SECRET` in the service environment.
6. Set `PUBLIC_ORIGIN` to the deployed HTTPS origin if using a custom cross-origin frontend.
7. Configure `/health` as the health-check path.

Run one service instance for this JSON-backed build. The disk stores the JSON database and `uploads` directory. Back up `/var/data` before deployments or secret rotation. HTTPS is provided by Render's public service endpoint. For multiple app instances, move state to PostgreSQL and configure a shared Socket.IO adapter before scaling out.

## Verification

Run `npm test` for the automated server integration test. It checks the exact suite count, booking validation, key privacy, capacity enforcement, socket chat, upload access, server-validated Tic-Tac-Toe turns/win state, owner authentication and private booking inspection, and suite reset. `node --check server.js` and `node --check public/app.js` check JavaScript syntax.

The automated test does not exercise visual layout across real phones, YouTube playback from external sources, autoplay behavior, or production Render configuration. Those require browser/device and deployment checks.

The owner can inspect booking details after signing in. Booking phone numbers are never returned by public suite APIs.
