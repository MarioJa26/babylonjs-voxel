import js from "@eslint/js";
import vuePlugin from "eslint-plugin-vue";
import tsEslint from "typescript-eslint"; // <--- Add this import

export default tsEslint.config(
  // <--- Wrap the whole array in tsEslint.config
  // 1. Global Ignores
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "src/BabylonExamples/**",
      "tests/**",
    ],
  },

  // 2. Base configs
  js.configs.recommended,
  ...tsEslint.configs.recommended, // <--- Add TypeScript recommended rules
  ...vuePlugin.configs["flat/essential"],

  {
    files: ["**/*.ts", "**/*.tsx", "**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tsEslint.parser, // <--- Tell Vue to use TS parser for <script> blocks
        ecmaVersion: "latest",
        sourceType: "module",
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      "no-console": "off", // Simplified for now to unblock you
      "no-debugger": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    files: [
      "**/*.config.js",
      "**/*.config.mjs",
      "vite.config.ts",
      "eslint.config.mjs",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        __dirname: "readonly",
      },
    },
  },
);
