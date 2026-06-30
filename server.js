import express from "express";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  SESSION_SECRET = "dev-secret-change-me",
} = process.env;

const app = express();
app.use(
  cookieSession({
    name: "session",
    secret: SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  })
);
app.use(express.static(path.join(__dirname, "public")));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// --- Spotify OAuth -------------------------------------------------

app.get("/login", (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_REDIRECT_URI) {
    return res.status(500).send("Spotify isn't configured on this server yet.");
  }
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: "user-read-currently-playing user-read-playback-state",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.oauthState) {
    return res.status(400).send("Invalid OAuth state.");
  }

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    return res.status(502).send("Failed to exchange Spotify token.");
  }

  const tokens = await tokenRes.json();
  req.session.spotify = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  res.redirect("/");
});

app.get("/logout", (req, res) => {
  req.session = null;
  res.redirect("/");
});

async function getValidAccessToken(req) {
  const spotify = req.session?.spotify;
  if (!spotify) return null;

  if (Date.now() < spotify.expiresAt - 10_000) {
    return spotify.accessToken;
  }

  const refreshRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: spotify.refreshToken,
    }),
  });

  if (!refreshRes.ok) return null;

  const refreshed = await refreshRes.json();
  req.session.spotify = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || spotify.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  return req.session.spotify.accessToken;
}

app.get("/me/now-playing", async (req, res) => {
  const accessToken = await getValidAccessToken(req);
  if (!accessToken) return res.json({ loggedIn: false });

  const npRes = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (npRes.status === 204 || !npRes.ok) {
    return res.json({ loggedIn: true, playing: null });
  }

  const data = await npRes.json();
  if (!data?.item) return res.json({ loggedIn: true, playing: null });

  res.json({
    loggedIn: true,
    playing: {
      name: data.item.name,
      artist: data.item.artists?.map((a) => a.name).join(", "),
      album: data.item.album?.name,
      albumArt: data.item.album?.images?.[0]?.url,
      isPlaying: data.is_playing,
      progressMs: data.progress_ms,
      durationMs: data.item.duration_ms,
      url: data.item.external_urls?.spotify,
    },
  });
});

// Last known room state, so a client joining late gets caught up.
let state = { action: "pause", time: 0, trackUrl: null, updatedAt: Date.now() };

// listenerId -> { displayName, playing }, so late joiners see who's listening to what.
const nowPlayingByListener = new Map();

function broadcast(data, except) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

wss.on("connection", (ws) => {
  ws.listenerId = crypto.randomBytes(8).toString("hex");

  // Catch the new client up on current state immediately.
  ws.send(JSON.stringify({ type: "state", ...state }));
  ws.send(
    JSON.stringify({
      type: "nowPlayingRoster",
      listeners: Object.fromEntries(nowPlayingByListener),
    })
  );

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
      // Echo back to the sender too, so their own player loads the track.
      broadcast({ type: "state", ...state, source: "track" });
    }

    if (msg.type === "nowPlaying") {
      nowPlayingByListener.set(ws.listenerId, {
        displayName: msg.displayName || "Someone",
        playing: msg.playing || null,
      });
      // Echo to everyone, including the sender, so the roster stays consistent.
      broadcast({
        type: "nowPlayingRoster",
        listeners: Object.fromEntries(nowPlayingByListener),
      });
    }
  });

  ws.on("close", () => {
    if (nowPlayingByListener.delete(ws.listenerId)) {
      broadcast({
        type: "nowPlayingRoster",
        listeners: Object.fromEntries(nowPlayingByListener),
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
