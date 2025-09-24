import net from "net";

let AuroraSocket = null ;
const server = net.createServer((socket) => {
	socket.on("data", (data) => {
		console.log("Received data:", data.toString());
	});
});
server.on("connection", (socket) => {
    console.log("New client connected:", socket.remoteAddress, socket.remotePort);
    socket.write("Welcome to the TCP server!\n");
    AuroraSocket = socket;
});

server.listen(5180, () => {
	console.log("TCP server listening on port 5180");
});

setInterval(() => {
	if (AuroraSocket) {
		AuroraSocket.write("Jesusito\n");
	}
}, 1000);

export function sendDatatoAurora(data) {
    if (AuroraSocket) {
        AuroraSocket.write(data + "\n");
    } else {
        console.log("No client connected to send data.");
    }
}