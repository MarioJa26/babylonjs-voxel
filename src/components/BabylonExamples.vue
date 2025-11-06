<template>
  <div>
    <canvas></canvas>
    <div id="fps">0</div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { TestScene } from "@/code/TestScene";

import "@/style/hud.css";
import "@/style/Item.css";

export default defineComponent({
  name: "BabylonExamples",
  data: () => ({
    testScene: null as TestScene | null,
  }),

  async mounted() {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    this.testScene = new TestScene(document, canvas);
    await this.testScene.initPromise;
  },
  beforeUnmount() {
    if (this.testScene) {
      this.testScene.connection.disconnect();
    }
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
