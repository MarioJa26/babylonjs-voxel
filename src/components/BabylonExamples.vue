<template>
  <div>
    <canvas></canvas>
    <div id="fps">0</div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
//import { Client, Room } from "colyseus.js";
import { TestScene } from "@/code/TestScene";

import "@/style/hud.css";
import "@/style/Item.css";

export default defineComponent({
  name: "BabylonExamples",

  async mounted() {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    new TestScene(document, canvas);

    /*
    // ✅ Initialize Colyseus client
    const client = new Client("ws://localhost:2567");

    try {
      // ✅ Join or create a room
      const room: Room = await client.joinOrCreate("my_room_name");

      console.log("✅ Joined Colyseus room:", room.roomId);

      // Listen for state updates from the server
      room.onStateChange((state) => {
        console.log("📦 State changed:", state);
      });

      // Listen for messages from the server
      room.onMessage("messageType", (message) => {
        console.log("💬 Received message:", message);
      });

      // Send a message to the server
      room.send("messageType", { hello: "world" });

      // Handle room close
      room.onLeave((code) => {
        console.log("👋 Left room with code:", code);
      });
    } catch (err) {
      console.error("❌ Error joining Colyseus room:", err);
    }
      */
  },
});
</script>

<style scoped>
div {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background-color: rgb(46, 46, 46);
}

canvas {
  width: 100%;
  height: 100%;
}
</style>
