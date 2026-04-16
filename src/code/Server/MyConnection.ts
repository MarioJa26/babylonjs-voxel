import { Client, Room } from "colyseus.js";

export class MyConnection {
	// ✅ Initialize Colyseus client
	client: Client;
	room?: Room;

	constructor() {
		this.client = new Client("ws://localhost:2567");
	}

	async connect() {
		try {
			// ✅ Join or create a room
			this.room = await this.client.joinOrCreate("my_room_name");

			console.log("✅ Joined Colyseus room:", this.room.roomId);

			// Listen for state updates from the server
			this.room.onStateChange((state) => {
				console.log("📦 State changed:", state);
			});

			// Listen for messages from the server
			this.room.onMessage("messageType", (message) => {
				console.log("💬 Received message:", message);
			});

			// Send a message to the server
			this.room.send("messageType", { hello: "world" });

			// Handle room close
			this.room.onLeave((code) => {
				console.log("👋 Left room with code:", code);
				this.room = undefined;
			});
		} catch (err) {
			console.error("❌ Error joining Colyseus room:", err);
		}
	}

	disconnect() {
		this.room?.leave();
	}
}
