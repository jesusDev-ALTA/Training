// server.mjs — MJPEG‑only backend (ESM)
// 1) TCP server recibe frames JPEG de una cámara/cliente.
// 2) HTTP expone /stream.mjpg (multipart/x-mixed-replace) y /stats /health.
// 3) Sin Socket.IO. Con CORS para permitir snapshot por <canvas>.
//
// Uso:
//   - package.json: { "type": "module" }
//   - npm i express cors
//   - node server.mjs
//
// Variables de entorno (opcionales):
//   HTTP_PORT=3000 TCP_PORT=9000 FRAME_MODE=jpeg-markers EMIT_FPS=12 CORS_ORIGIN=*
//   FRAME_MODE: 'jpeg-markers' | 'len-prefix'

import http from "node:http";
import net from "node:net";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";

// ======= Config =======
const HTTP_PORT = Number(process.env.HTTP_PORT || 3000);
const TCP_PORT = Number(process.env.TCP_PORT || 9000);
const FRAME_MODE = process.env.FRAME_MODE || "jpeg-markers"; // 'jpeg-markers' | 'len-prefix'
const EMIT_FPS = Math.max(1, Number(process.env.EMIT_FPS || 12));
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// ======= Paths =======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

// ======= State =======
let latestFrame = null; // Buffer del último JPEG
let framesReceived = 0; // contador total
let bytesLastFrame = 0; // tamaño del último frame
let tcpClients = new Set(); // conexiones de cámara
let mjpegClients = new Set(); // respuestas HTTP activas del stream

// ======= HTTP (Express) =======
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

// Salud + métricas
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/stats", (_req, res) => {
	res.json({
		tcpClients: tcpClients.size,
		mjpegClients: mjpegClients.size,
		framesReceived,
		bytesLastFrame,
		frameMode: FRAME_MODE,
		emitFps: EMIT_FPS,
	});
});

// Endpoint MJPEG (agrega CORS explícito en la respuesta streaming)
app.get("/stream.mjpg", (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
	res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
	res.setHeader("Pragma", "no-cache");
	res.setHeader("Connection", "close");
	res.writeHead(200, {
		"Content-Type": "multipart/x-mixed-replace; boundary=frame",
	});

	// Registrar cliente y limpiar al desconectar
	mjpegClients.add(res);
	req.on("close", () => {
		mjpegClients.delete(res);
		try {
			res.end();
		} catch {}
	});
});

// Servir un index si existe en /public, si no, instrucción básica
app.get("/", (req, res, next) => {
	if (PUBLIC_DIR) {
		res.sendFile(path.join(PUBLIC_DIR, "index.html"), (err) => {
			if (err) next();
		});
	} else {
		next();
	}
});

const httpServer = http.createServer(app);
httpServer.listen(HTTP_PORT, () => {
	console.log(`HTTP listening on :${HTTP_PORT}`);
});

// ======= Broadcast de frames a todos los clientes MJPEG =======
function writeFrameTo(res, frame) {
	res.write(`--frame\r\n`);
	res.write(`Content-Type: image/jpeg\r\n`);
	res.write(`Content-Length: ${frame.length}\r\n\r\n`);
	res.write(frame);
	res.write(`\r\n`);
}

setInterval(() => {
	if (!latestFrame || mjpegClients.size === 0) return;
	for (const res of Array.from(mjpegClients)) {
		try {
			writeFrameTo(res, latestFrame);
		} catch {
			mjpegClients.delete(res);
			try {
				res.end();
			} catch {}
		}
	}
}, Math.floor(1000 / EMIT_FPS));

// ======= TCP Server (entrada de la cámara) =======
const tcpServer = net.createServer();

tcpServer.on("connection", (socket) => {
	console.log(
		`[TCP] camera connected from ${socket.remoteAddress}:${socket.remotePort}`
	);
	tcpClients.add(socket);

	let buffer = Buffer.alloc(0);
	let pendingLen = null; // para modo len-prefix

	const SOI = Buffer.from([0xff, 0xd8]); // JPEG Start of Image
	const EOI = Buffer.from([0xff, 0xd9]); // JPEG End of Image

	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);

		if (FRAME_MODE === "len-prefix") {
			// Espera: [4-byte length][JPEG] ... repetido
			for (;;) {
				if (pendingLen === null) {
					if (buffer.length < 4) break;
					pendingLen = buffer.readUInt32BE(0);
					buffer = buffer.slice(4);
				}
				if (buffer.length < pendingLen) break;
				const frame = buffer.slice(0, pendingLen);
				buffer = buffer.slice(pendingLen);
				pendingLen = null;
				handleFrame(frame);
			}
		} else {
			// Modo jpeg-markers (SOI/EOI)
			for (;;) {
				const start = buffer.indexOf(SOI);
				if (start === -1) {
					if (buffer.length > 5 * 1024 * 1024)
						buffer = buffer.slice(-1024 * 1024);
					break;
				}
				const end = buffer.indexOf(EOI, start + 2);
				if (end === -1) break;
				const frame = buffer.slice(start, end + 2);
				buffer = buffer.slice(end + 2);
				handleFrame(frame);
			}
		}
	});

	socket.on("close", () => {
		tcpClients.delete(socket);
		console.log("[TCP] camera disconnected");
	});

	socket.on("error", (err) => {
		tcpClients.delete(socket);
		console.warn("[TCP] error:", err.message);
	});
});

function handleFrame(frame) {
	if (!frame || frame.length < 128) return; // sanity mínima
	latestFrame = frame; // conservar sólo el último para baja latencia
	framesReceived++;
	bytesLastFrame = frame.length;
}

// Evitar quedarse sin recursos con muchas conexiones
tcpServer.maxConnections = 256;

tcpServer.listen(TCP_PORT, () => {
	console.log(`TCP camera server listening on :${TCP_PORT}`);
	console.log(`Frame mode: ${FRAME_MODE}`);
});

// ======= Graceful shutdown =======
function shutdown() {
	console.log("Shutting down...");
	try {
		tcpServer.close();
	} catch {}
	for (const s of tcpClients) {
		try {
			s.destroy();
		} catch {}
	}
	for (const r of mjpegClients) {
		try {
			r.end();
		} catch {}
	}
	try {
		httpServer.close(() => process.exit(0));
	} catch {
		process.exit(0);
	}
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
