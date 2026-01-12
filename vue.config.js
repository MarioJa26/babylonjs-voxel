const { defineConfig } = require("@vue/cli-service");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = defineConfig({
  transpileDependencies: false,

  // --- DEVELOPMENT ---
  // You already have this, which is great for preventing costly reloads.
  devServer: {
    hot: false,
    liveReload: false,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },

  // --- PRODUCTION ---
  // Set this to the sub-path if you are deploying to a folder.
  // For example, if deploying to 'https://my-username.github.io/my-game/',
  // set publicPath: '/my-game/'. Defaults to '/'.
  publicPath: process.env.NODE_ENV === "production" ? "/" : "/",

  // Disable source maps in production for a smaller build and to hide source code.
  productionSourceMap: false,

  // --- WEBPACK CUSTOMIZATION ---
  chainWebpack: (config) => {
    // Add a rule to allow importing .glsl files as strings
    config.module
      .rule("glsl")
      .test(/\.(glsl|vs|fs|vert|frag)$/)
      .use("raw-loader")
      .loader("raw-loader")
      .end();

    // Define Vue feature flags to remove the warning
    config.plugin("define").tap((args) => {
      // Setting these to 'false' for production can improve tree-shaking.
      // __VUE_OPTIONS_API__: true is needed if you use the Options API.
      args[0]["__VUE_OPTIONS_API__"] = JSON.stringify(true);
      args[0]["__VUE_PROD_DEVTOOLS__"] = JSON.stringify(false);
      args[0]["__VUE_PROD_HYDRATION_MISMATCH_DETAILS__"] =
        JSON.stringify(false);
      return args;
    });

    // Drop console logs in production to improve runtime performance
    if (process.env.NODE_ENV === "production") {
      config.optimization.minimizer("terser").tap((args) => {
        const terserOptions = args[0].terserOptions || {};
        terserOptions.compress = {
          ...terserOptions.compress,
          drop_console: true,
        };
        args[0].terserOptions = terserOptions;
        return args;
      });
    }
  },

  /*
  configureWebpack: {
    plugins: [
      // Copy game assets from src/assets to the output 'assets' folder
      new CopyWebpackPlugin({
        patterns: [{ from: "src/assets/models", to: "assets/models" }],
      }),
    ],
  },
  */
});
