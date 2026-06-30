import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Last known room state, so a client joining late gets caught up.
let state = { action: "pause", time: 0, trackUrl: null, updatedAt: Date.now() };

function broadcast(data, except) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

wss.on("connection", (ws) => {
  // Catch the new client up on current state immediately.
  ws.send(JSON.stringify({ type: "state", ...state }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "play" || msg.type === "pause" || msg.type === "seek") {
      state = {
        action: msg.type === "seek" ? state.action : msg.type,
        time: msg.time,
        trackUrl: state.trackUrl,
        updatedAt: Date.now(),
      };
      broadcast({ type: "state", ...state, source: msg.type }, ws);
    }

    if (msg.type === "track") {
      state = { action: "pause", time: 0, trackUrl: msg.url, updatedAt: Date.now() };
      broadcast({ type: "state", ...state, source: "track" }, ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
