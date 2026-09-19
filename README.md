# Attendly

A personal college attendance calculator with an optional SQLite database backend.

## Run with SQLite persistence

Requires Node 22.5+ (Node 24 recommended):

```bash
node server.js
```

Open <http://localhost:4173> in a browser.

- `attendly.sqlite` is created automatically on first run.
- The UI syncs state to SQLite through `/api/state`.
- If the HTML is opened directly as a file, it still works with browser `localStorage` as a fallback.
- No login or public network access is included; it is intended for personal/local use.

## Deploy to Render

The included `render.yaml` configures a Node web service with a persistent disk. Upload this folder to a GitHub repository, create a new Render Blueprint from that repository, and deploy. Render persistent disks may require a paid instance depending on your plan.

## Gemini AI timetable autofill (text, CSV, images, and PDFs)

The backend includes a secure `POST /api/parse-timetable` endpoint. Set `GEMINI_API_KEY` as a server environment variable; never put the key in `index.html`, GitHub, or chat. When running locally:

```bash
GEMINI_API_KEY="your-new-key" node server.js
```

On Render, add `GEMINI_API_KEY` in the service environment settings. GitHub Pages keeps the local smart parser available, but cannot run the secure Gemini endpoint by itself.
