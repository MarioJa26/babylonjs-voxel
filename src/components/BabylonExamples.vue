<template>
  <div class="game-container">
    <canvas ref="bjsCanvas"></canvas>
  </div>
</template>

<script setup lang="ts">
/* global document, HTMLCanvasElement */
import { ref, onMounted, onBeforeUnmount } from "vue";
import { TestScene } from "@/code/TestScene";

// Vite handles these imports automatically
import "@/style/hud.css";
import "@/style/Item.css";

// 1. Reactive reference to the canvas element
const bjsCanvas = ref<HTMLCanvasElement | null>(null);
let testScene: TestScene | null = null;

onMounted(async () => {
	document.title = "b102 - " + new Date().toLocaleTimeString();

	if (bjsCanvas.value) {
		// 2. Initialize the scene with the ref value
		testScene = new TestScene(document, bjsCanvas.value);
		await testScene.initPromise;
	}
});

onBeforeUnmount(() => {
	if (testScene) {
		// Optional: Dispose of the Babylon engine here to prevent memory leaks
		// testScene.engine.dispose();
	}
});
</script>

<style scoped>
.game-container {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background-color: rgb(30, 38, 36);
  overflow: hidden;
  /* Prevents scrollbars on the canvas */
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
  /* Removes the 4px baseline gap */
  outline: none;
  /* Prevents the focus ring when clicking the canvas */
}
</style>