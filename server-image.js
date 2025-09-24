// server.mjs
// Node.js (ESM) backend that:
// 1) Listens as a TCP SERVER to receive JPEG frames from a camera client.
// 2) Rebroadcasts the latest frame to browsers via Socket.IO (binary) and an MJPEG HTTP endpoint.
// 3) Exposes /stats and /health for quick checks.
//
// Usage
//   - Ensure package.json has { "type": "module" }
//   - npm i express socket.io cors
//   - node server.mjs
//
// Camera framing supported (choose with FRAME_MODE):
//   - "jpeg-markers": find frames by JPEG SOI/EOI markers (0xFFD8 ... 0xFFD9)
//   - "len-prefix":  4-byte big-endian length prefix before each JPEG


import http from 'node:http';
import net from 'node:net';
import process from 'node:process';
import express from 'express';
import cors from 'cors';
import { Server as IOServer } from 'socket.io';

// ======= Config =======
const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const TCP_PORT  = Number(process.env.TCP_PORT  || 9000);
const FRAME_MODE = (process.env.FRAME_MODE || 'jpeg-markers'); // 'jpeg-markers' | 'len-prefix'
const EMIT_FPS = Number(process.env.EMIT_FPS || 12); // throttle broadcast to clients
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'; // set your domain in prod

// ======= State =======
let latestFrame = null;              // Buffer of the most recent JPEG
let framesReceived = 0;              // counter
let bytesLastFrame = 0;              // size of last frame
let tcpClients = new Set();          // camera connections
let wsClients = 0;                   // count of websocket clients

// ======= HTTP + Socket.IO =======
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));

const httpServer = http.createServer(app);
const io = new IOServer(httpServer, { cors: { origin: CORS_ORIGIN } });

io.on('connection', (socket) => {
  wsClients++;
  // Send a hello + maybe prime with a current frame
  socket.emit('hello', { ok: true, mode: 'binary-jpeg', fps: EMIT_FPS });
  if (latestFrame) socket.emit('frame', latestFrame);

  socket.on('disconnect', () => { wsClients--; });
});

// Broadcast (throttled)
setInterval(() => {
  if (!latestFrame) return;
  io.emit('frame', latestFrame);
}, Math.max(1, Math.floor(1000 / EMIT_FPS)));

app.get("/", (_req, res) =>
    res.sendFile('index3.html', { root: 'public' })
);

// Simple health & stats
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
app.get("/stats", (_req, res) => {
	res.json({
		wsClients,
		tcpClients: tcpClients.size,
		framesReceived,
		bytesLastFrame,
		frameMode: FRAME_MODE,
		emitFps: EMIT_FPS,
	});
});

// MJPEG endpoint
app.get('/stream.mjpg', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'close',
  });

  const timer = setInterval(() => {
    if (!latestFrame) return;
    try {
      res.write(`--frame\r\n`);
      res.write(`Content-Type: image/jpeg\r\n`);
      res.write(`Content-Length: ${latestFrame.length}\r\n\r\n`);
      res.write(latestFrame);
      res.write(`\r\n`);
    } catch (e) {
      clearInterval(timer);
      try { res.end(); } catch {}
    }
  }, Math.max(1, Math.floor(1000 / EMIT_FPS)));

  req.on('close', () => clearInterval(timer));
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP + Socket.IO listening on :${HTTP_PORT}`);
});

// ======= TCP Server (camera input) =======
const tcpServer = net.createServer();

tcpServer.on('connection', (socket) => {
  console.log(`[TCP] camera connected from ${socket.remoteAddress}:${socket.remotePort}`);
  tcpClients.add(socket);

  let buffer = Buffer.alloc(0);
  let pendingLen = null; // for len-prefix mode

  const SOI = Buffer.from([0xFF, 0xD8]); // JPEG Start of Image
  const EOI = Buffer.from([0xFF, 0xD9]); // JPEG End of Image

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (FRAME_MODE === 'len-prefix') {
      // Expect: [4-byte length][JPEG-bytes] ... repeated
      for (;;) {
        if (pendingLen === null) {
          if (buffer.length < 4) break; // need length
          pendingLen = buffer.readUInt32BE(0);
          buffer = buffer.slice(4);
        }
        if (buffer.length < pendingLen) break; // wait more
        const frame = buffer.slice(0, pendingLen);
        buffer = buffer.slice(pendingLen);
        pendingLen = null;
        handleFrame(frame);
      }
    } else {
      // jpeg-markers mode
      for (;;) {
        const start = buffer.indexOf(SOI);
        if (start === -1) { // no SOI yet, keep a limited buffer
          // prevent unbounded growth
          if (buffer.length > 5 * 1024 * 1024) buffer = buffer.slice(-1024 * 1024);
          break;
        }
        const end = buffer.indexOf(EOI, start + 2);
        if (end === -1) break; // wait for full frame
        const frame = buffer.slice(start, end + 2);
        buffer = buffer.slice(end + 2);
        handleFrame(frame);
      }
    }
  });

  socket.on('close', () => {
    tcpClients.delete(socket);
    console.log('[TCP] camera disconnected');
  });

  socket.on('error', (err) => {
    tcpClients.delete(socket);
    console.warn('[TCP] error:', err.message);
  });
});

function handleFrame(frame) {
  // Basic sanity: minimal JPEG size
  if (!frame || frame.length < 128) return;
  latestFrame = frame; // keep only the last frame to minimize latency
  framesReceived++;
  bytesLastFrame = frame.length;
}

// Keep server alive even with many connections in TIME_WAIT
tcpServer.maxConnections = 128;

tcpServer.listen(TCP_PORT, () => {
  console.log(`TCP camera server listening on :${TCP_PORT}`);
  console.log(`Frame mode: ${FRAME_MODE}`);
});

// ======= Graceful shutdown =======
function shutdown() {
  console.log('Shutting down...');
  try { tcpServer.close(); } catch {}
  for (const s of tcpClients) { try { s.destroy(); } catch {} }
  try { httpServer.close(() => process.exit(0)); } catch { process.exit(0); }
}



