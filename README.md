# Turf Clash

Turf Clash is a browser-based 3D territory game. Practice and Quick play run locally with three bots. Friend rooms use an authoritative WebSocket server and support two to eight human players.

## Run friend rooms

Use Node 22.18+.

```sh
npm ci
npm install --prefix server
VITE_WS_URL=/turf-ws npm run build
npm run dev:server
```

Open http://127.0.0.1:8787 in two browser sessions. Choose **Play with friends**, create a room, and share its six-character code or invite link. Friends choose **Join room** and mark themselves ready. The host starts the match once everyone is ready. Players can customize their avatars in the lobby, and the host controls the shared match settings and rematches.

In PowerShell, use `$env:VITE_WS_URL = '/turf-ws'; npm run build` for the local build. Production builds use the Render room server configured in `.env.production`. Vercel can override the URL with its project environment variable.

To use Vite with hot reload, start the room server alongside `npm run dev`. Vite proxies `/turf-ws` to port 8787. Set `TURF_SERVER_URL` if your development room server uses another port.

For LAN play, run the room server with `HOST=0.0.0.0` and share the website's LAN address. For friends outside the network, run the Node server on a reachable host and put it behind an HTTPS reverse proxy that forwards WebSocket upgrades on `/turf-ws`. If the site and room server use different origins, set `VITE_WS_URL` before building the frontend and set `ALLOWED_ORIGINS` on the server to the site's exact HTTPS origin. Room codes and invites refer to the server that created them. Rooms live in memory and are lost on a server restart.

Players can reconnect automatically or enter the same code in the browser that saved their seat. A returning player can move if they still own turf. Players who lose all their turf and new visitors who join during a match can spectate until it ends.

## Rules and verification

Use WASD, arrows, or the touch joystick. Leave your color and reconnect to it to capture an enclosed area. Crossing another player's open trail knocks that player out and sends them back after the configured delay. Crossing your own open trail sends you back immediately. Both resets preserve captured turf. The server applies these rules, tracks positions and scores, and sends the same final ranking to all players.

Enable **Auto-run** in settings to keep moving after releasing a direction. Press **Space** or the in-match pause button to stop auto-run. Respawning clears the saved direction.

```sh
npm run typecheck
npm test
npm run test:server
npm run build
```
