import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const httpsKeyFile = process.env.HTTPS_KEY_FILE;
const httpsCertFile = process.env.HTTPS_CERT_FILE;
const useHttps = Boolean(httpsKeyFile && httpsCertFile);
const port = Number(process.env.PORT || (useHttps ? 443 : 3000));
const defaultIceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" }
];
const iceTransportPolicy = process.env.ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all";

const rooms = new Map();
let messageId = 1;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const createToken = () => randomBytes(24).toString("base64url");
const createRoomId = () => String(Math.floor(100000 + Math.random() * 900000));
const hashPassword = (password, salt) =>
  createHash("sha256").update(`${salt}:${password}`).digest("hex");

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeIceServer(server) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error("ICE server config entries must be objects.");
  }

  const urls = Array.isArray(server.urls)
    ? server.urls.map((url) => String(url).trim()).filter(Boolean)
    : String(server.urls || "").trim();

  if (!urls || (Array.isArray(urls) && urls.length === 0)) {
    throw new Error("ICE server config entries require urls.");
  }

  const normalized = { urls };
  for (const key of ["username", "credential", "credentialType"]) {
    if (server[key]) normalized[key] = String(server[key]);
  }
  return normalized;
}

function buildIceServers() {
  const jsonConfig = process.env.ICE_SERVERS_JSON?.trim();
  if (jsonConfig) {
    const parsed = JSON.parse(jsonConfig);
    if (!Array.isArray(parsed)) {
      throw new Error("ICE_SERVERS_JSON must be a JSON array.");
    }
    return parsed.map(normalizeIceServer);
  }

  const iceServers = [...defaultIceServers];
  const turnUrls = parseCsv(process.env.TURN_URLS);
  if (turnUrls.length) {
    const turnServer = { urls: turnUrls };
    if (process.env.TURN_USERNAME) turnServer.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turnServer.credential = process.env.TURN_CREDENTIAL;
    if (process.env.TURN_CREDENTIAL_TYPE) {
      turnServer.credentialType = process.env.TURN_CREDENTIAL_TYPE;
    }
    iceServers.push(normalizeIceServer(turnServer));
  }
  return iceServers;
}

const iceServers = buildIceServers();

function passwordsMatch(room, password) {
  const incoming = Buffer.from(hashPassword(password, room.salt), "hex");
  const expected = Buffer.from(room.passwordHash, "hex");
  return incoming.length === expected.length && timingSafeEqual(incoming, expected);
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    sharing: room.sharing,
    viewerCount: room.viewers.size
  };
}

function pushHost(room, type, payload = {}) {
  room.hostQueue.push({ id: messageId++, type, payload, at: Date.now() });
}

function pushViewer(room, viewerId, type, payload = {}) {
  const viewer = room.viewers.get(viewerId);
  if (!viewer) return;
  viewer.queue.push({ id: messageId++, type, payload, at: Date.now() });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      throw Object.assign(new Error("Request body is too large."), { status: 413 });
    }
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    throw Object.assign(new Error("房间不存在或已关闭。"), { status: 404 });
  }
  return room;
}

function requireHost(room, token) {
  if (!token || token !== room.hostToken) {
    throw Object.assign(new Error("房主身份已失效，请重新开房间。"), { status: 401 });
  }
}

function requireViewer(room, viewerId, token) {
  const viewer = room.viewers.get(viewerId);
  if (!viewer || !token || token !== viewer.token) {
    throw Object.assign(new Error("观看身份已失效，请重新加入。"), { status: 401 });
  }
  return viewer;
}

function pruneRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    const inactiveFor = now - room.updatedAt;
    if (inactiveFor > 1000 * 60 * 60 * 6) {
      rooms.delete(roomId);
    }
  }
}

function waitForEvents(queue, cursor, timeout = 25000) {
  const start = Date.now();

  return new Promise((resolve) => {
    const tick = () => {
      const events = queue.filter((event) => event.id > cursor);
      if (events.length || Date.now() - start >= timeout) {
        resolve(events);
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === "GET" && pathname === "/api/config") {
    sendJson(res, 200, {
      iceServers,
      iceTransportPolicy,
      turnEnabled: iceServers.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => String(url).startsWith("turn:") || String(url).startsWith("turns:"));
      })
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/rooms") {
    const body = await readBody(req);
    const password = String(body.password || "").trim();
    const name = String(body.name || "我的投屏房间").trim().slice(0, 40);

    if (password.length < 4) {
      sendJson(res, 400, { error: "密码至少需要 4 位。" });
      return;
    }

    let id = createRoomId();
    while (rooms.has(id)) id = createRoomId();

    const salt = createToken();
    const room = {
      id,
      name,
      salt,
      passwordHash: hashPassword(password, salt),
      hostToken: createToken(),
      hostQueue: [],
      viewers: new Map(),
      sharing: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    rooms.set(id, room);
    sendJson(res, 201, { room: publicRoom(room), hostToken: room.hostToken });
    return;
  }

  const joinMatch = pathname.match(/^\/api\/rooms\/([0-9]{6})\/join$/);
  if (req.method === "POST" && joinMatch) {
    const room = getRoom(joinMatch[1]);
    const body = await readBody(req);
    const password = String(body.password || "").trim();
    const name = String(body.name || "观众").trim().slice(0, 24);

    if (!passwordsMatch(room, password)) {
      sendJson(res, 403, { error: "房间号或密码不正确。" });
      return;
    }

    const viewerId = createToken();
    const viewer = {
      id: viewerId,
      token: createToken(),
      name,
      queue: [],
      joinedAt: Date.now(),
      updatedAt: Date.now()
    };

    room.viewers.set(viewerId, viewer);
    room.updatedAt = Date.now();
    pushHost(room, "viewer-joined", { viewerId, name, viewerCount: room.viewers.size });
    sendJson(res, 200, {
      room: publicRoom(room),
      viewerId,
      viewerToken: viewer.token
    });
    return;
  }

  const leaveMatch = pathname.match(/^\/api\/rooms\/([0-9]{6})\/viewers\/([^/]+)$/);
  if (req.method === "DELETE" && leaveMatch) {
    const room = getRoom(leaveMatch[1]);
    const viewerId = decodeURIComponent(leaveMatch[2]);
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const viewer = requireViewer(room, viewerId, token);
    room.viewers.delete(viewer.id);
    room.updatedAt = Date.now();
    pushHost(room, "viewer-left", { viewerId, viewerCount: room.viewers.size });
    sendJson(res, 200, { ok: true });
    return;
  }

  const closeMatch = pathname.match(/^\/api\/rooms\/([0-9]{6})$/);
  if (req.method === "DELETE" && closeMatch) {
    const room = getRoom(closeMatch[1]);
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    requireHost(room, token);
    for (const viewer of room.viewers.values()) {
      pushViewer(room, viewer.id, "room-closed");
    }
    rooms.delete(room.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/rooms\/([0-9]{6})\/status$/);
  if (req.method === "POST" && statusMatch) {
    const room = getRoom(statusMatch[1]);
    const body = await readBody(req);
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    requireHost(room, token);
    room.sharing = Boolean(body.sharing);
    room.updatedAt = Date.now();
    for (const viewer of room.viewers.values()) {
      pushViewer(room, viewer.id, "sharing-status", { sharing: room.sharing });
    }
    sendJson(res, 200, { room: publicRoom(room) });
    return;
  }

  const hostEventsMatch = pathname.match(/^\/api\/rooms\/([0-9]{6})\/host-events$/);
  if (req.method === "GET" && hostEventsMatch) {
    const room = getRoom(hostEventsMatch[1]);
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    requireHost(room, token);
    const cursor = Number(searchParams.get("cursor") || 0);
    const events = await waitForEvents(room.hostQueue, cursor);
    room.updatedAt = Date.now();
    sendJson(res, 200, { events, room: publicRoom(room) });
    return;
  }

  const viewerEventsMatch = pathname.match(/^\/api\/rooms\/([0-9]{6})\/viewers\/([^/]+)\/events$/);
  if (req.method === "GET" && viewerEventsMatch) {
    const room = getRoom(viewerEventsMatch[1]);
    const viewerId = decodeURIComponent(viewerEventsMatch[2]);
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const viewer = requireViewer(room, viewerId, token);
    const cursor = Number(searchParams.get("cursor") || 0);
    const events = await waitForEvents(viewer.queue, cursor);
    viewer.updatedAt = Date.now();
    room.updatedAt = Date.now();
    sendJson(res, 200, { events, room: publicRoom(room) });
    return;
  }

  const signalMatch = pathname.match(/^\/api\/rooms\/([0-9]{6})\/signal$/);
  if (req.method === "POST" && signalMatch) {
    const room = getRoom(signalMatch[1]);
    const body = await readBody(req);
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const from = String(body.from || "");
    const to = String(body.to || "");
    const signal = body.signal;

    if (!signal || typeof signal !== "object") {
      sendJson(res, 400, { error: "缺少信令内容。" });
      return;
    }

    if (from === "host") {
      requireHost(room, token);
      if (!to) {
        sendJson(res, 400, { error: "缺少观众 ID。" });
        return;
      }
      pushViewer(room, to, "signal", { from: "host", signal });
    } else {
      const viewer = requireViewer(room, from, token);
      pushHost(room, "signal", { from: viewer.id, signal });
    }

    room.updatedAt = Date.now();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "接口不存在。" });
}

async function serveStatic(req, res, pathname) {
  const safePath = normalize(pathname === "/" ? "/index.html" : pathname);
  if (safePath.includes("..")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const filePath = join(publicDir, safePath);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  } catch {
    const data = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(data);
  }
}

const requestHandler = async (req, res) => {
  pruneRooms();

  try {
    const protocol = useHttps ? "https" : "http";
    const url = new URL(req.url || "/", `${protocol}://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, {
      error: status === 500 ? "服务端遇到问题，请稍后重试。" : error.message
    });
    if (status === 500) console.error(error);
  }
};

const server = useHttps
  ? createHttpsServer(
      {
        key: readFileSync(httpsKeyFile),
        cert: readFileSync(httpsCertFile)
      },
      requestHandler
    )
  : createHttpServer(requestHandler);

server.listen(port, "0.0.0.0", () => {
  const protocol = useHttps ? "https" : "http";
  console.log(`Screen Room is running at ${protocol}://localhost:${port}`);
  console.log(`ICE servers configured: ${iceServers.length}; TURN enabled: ${iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => String(url).startsWith("turn:") || String(url).startsWith("turns:"));
  })}`);
});
