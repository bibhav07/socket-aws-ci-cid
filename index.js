import express from "express";
import http from "http";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import {Server as SocketIOServer} from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());

// Serve static frontend from ../client
app.use(express.static(path.join(__dirname, "./client")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "./client", "index.html"));
});

app.get("/health", (_req, res) => {
    res.json({status : "healthy", message: "App is healthy. Chat server runing"})
});

const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
    cors:{
        origin: "*",
        methods: ['GET', 'POST']
    }
});


/**
 * Presence state (in-memory)
 * - usernameToSocket: Map username -> socket.id
 * - socketToUser: Map socket.id -> username
 */
const usernameToSocket = new Map();
const socketToUser = new Map();

/**
 * Helper: get list of online usernames
 */
function getOnlineUsers() {
  return Array.from(usernameToSocket.keys()).sort();
}

/**
 * Helper: broadcast the online user list to everyone
 */
function broadcastUserList() {
  io.emit("user:list", getOnlineUsers());
}


/**
 * Helper: validate usernames
 */
function isValidUsername(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 24) return false;
  // letters, numbers, underscores, hyphens
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}


/**
 * Socket.IO connection
 */
io.on("connection", (socket) => {
  // Client must send 'user:login' once after connect
  socket.on("user:login", (username, ack) => {
    try {
      if (!isValidUsername(username)) {
        ack?.({ ok: false, error: "Invalid username. Use 3–24 chars: letters, numbers, _ or -." });
        return;
      }
      username = username.trim();

      // Reject duplicate usernames
      if (usernameToSocket.has(username)) {
        ack?.({ ok: false, error: "Username already in use. Pick another." });
        return;
      }

      // Register presence
      usernameToSocket.set(username, socket.id);
      socketToUser.set(socket.id, username);

      // Attach to socket for convenience
      socket.data.username = username;

      // Confirm login, send current online list
      ack?.({ ok: true, username, users: getOnlineUsers() });

      // Notify everyone
      broadcastUserList();
    } catch (err) {
      ack?.({ ok: false, error: "Login failed." });
    }
  });

  // Direct message: { to, text }
  socket.on("msg:send", (payload, ack) => {
    const fromUser = socket.data.username;
    if (!fromUser) {
      ack?.({ ok: false, error: "Not logged in." });
      return;
    }

    const { to, text } = payload || {};
    if (!to || typeof text !== "string" || !text.trim()) {
      ack?.({ ok: false, error: "Invalid message payload." });
      return;
    }

    // Check recipient online
    const recipientSocketId = usernameToSocket.get(to);
    if (!recipientSocketId) {
      ack?.({ ok: false, error: "Recipient is offline or does not exist." });
      return;
    }

    const msg = {
      from: fromUser,
      to,
      text: text.trim(),
      ts: Date.now()
    };

    // Emit to recipient only
    io.to(recipientSocketId).emit("msg:receive", msg);

    // Optional: echo back to sender for UI confirmation
    socket.emit("msg:sent", msg);

    ack?.({ ok: true });
  });

  // Client can request the list explicitly
  socket.on("user:list", (ack) => {
    ack?.({ ok: true, users: getOnlineUsers() });
  });

  // Handle disconnect: clean up presence
  socket.on("disconnect", () => {
    const username = socketToUser.get(socket.id);
    if (username) {
      usernameToSocket.delete(username);
      socketToUser.delete(socket.id);
      broadcastUserList();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Chat server listening on http://localhost:${PORT}`);
});