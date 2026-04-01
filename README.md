# Duosic

Duosic is a real-time synchronized music room app built with React, Express, Socket.IO, and MongoDB-ready room persistence. It supports shared rooms, synced playback controls, participant presence, and a production mode where one Node server can serve both the API and the built frontend.

## What is included

- `client/`: React + Vite app with room create/join flow, invite links, shared queue, and playback drift correction.
- `server/`: Express API, Socket.IO sync server, Mongo-backed room storage with memory fallback, and static client serving in production.
- `Dockerfile`: containerized deployment path for Railway, Render, Fly.io, Northflank, or any Docker host.

## Core experience

- Create or join a room with a short code
- Share an invite link directly from the UI
- Play, pause, seek, and switch tracks together
- Keep multiple tabs or devices aligned to the same playback state
- Preserve room state in MongoDB when available

## Local development

1. Install dependencies:

   ```powershell
   cd E:\01_MainData\Duosic\server
   npm install

   cd ..\client
   npm install
   ```

2. Create env files:

   ```powershell
   Copy-Item server\.env.example server\.env
   Copy-Item client\.env.example client\.env
   ```

3. Start the backend:

   ```powershell
   cd E:\01_MainData\Duosic\server
   npm run dev
   ```

4. Start the frontend:

   ```powershell
   cd E:\01_MainData\Duosic\client
   npm run dev
   ```

5. Open [http://localhost:5173](http://localhost:5173).

During development, Vite proxies `/api` and `/socket.io` to the Express server on port `4000`.

## Production build

Build the frontend:

```powershell
cd E:\01_MainData\Duosic
npm run build
```

Start the server:

```powershell
cd E:\01_MainData\Duosic\server
$env:NODE_ENV='production'
npm start
```

In production, the Express server serves `client/dist` directly, so the app works as a single long-running Node service with Socket.IO support.

## Environment

### Server

- `PORT=4000`
- `MONGO_URI=...`
- `CLIENT_ORIGIN=http://localhost:5173`
- `CLIENT_ORIGINS=https://your-frontend.example.com,https://www.your-frontend.example.com`
- `ROOM_IDLE_TTL_HOURS=12`

Notes:

- `CLIENT_ORIGIN` and `CLIENT_ORIGINS` are optional if frontend and backend are served from the same host.
- If `MONGO_URI` is missing or MongoDB is temporarily unreachable, the app falls back to in-memory room storage.
- Mongo-backed rooms get a TTL index so stale rooms expire automatically after 7 days of inactivity.

### Client

- `VITE_API_URL=`
- `VITE_SOCKET_URL=`

Leave both blank when the frontend is served by the same Express app. Only set them when you intentionally deploy the frontend and backend to different domains.

## Deployment notes

This app uses Socket.IO, so it should be deployed to a platform that supports long-lived Node processes or Docker containers. Good fits are Render, Railway, Fly.io, or a VPS/container host.

Vercel is not the right primary target for the realtime backend because persistent Socket.IO connections do not map cleanly to serverless functions.

### Render

This repo now includes [render.yaml](E:/01_MainData/Duosic/render.yaml#L1), so you can deploy it as a Render Blueprint.

1. Push this repo to GitHub.
2. In Render, choose `New +` -> `Blueprint`.
3. Select the repository and let Render detect `render.yaml`.
4. When prompted, set `MONGO_URI` to your production Mongo connection string.
5. Deploy the `duosic` web service.

Render automatically provides `RENDER_EXTERNAL_HOSTNAME`, and the server now accepts that hostname for CORS by default. The service health check is `/api/health`.

### Docker

Build and run locally:

```powershell
docker build -t duosic .
docker run -p 4000:4000 --env-file server/.env duosic
```

Then open [http://localhost:4000](http://localhost:4000).

## Architecture notes

- The server is the source of truth for room playback state.
- Playback uses `positionMs + updatedAt + isPlaying` instead of trusting each client clock directly.
- Clients compute expected playback time locally and correct audible drift when it exceeds a small threshold.
- Participant presence now supports multiple open tabs per listener without false offline toggles.
- Idle in-memory rooms are pruned automatically to keep the process clean between active sessions.

## Good next steps

- Add authentication and saved user profiles
- Add host permissions and room moderation
- Replace sample tracks with a licensed provider integration
- Add Redis for multi-instance Socket.IO scaling
