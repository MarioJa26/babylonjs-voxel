import js from "@eslint/js";
import vuePlugin from "eslint-plugin-vue";
import tsEslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // 1. Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "src/BabylonExamples/**",
      "src/code_js/**",
      "tests/**",
      "extract-footprint.cjs",
    ],
  },

  // 2. Base configs
  js.configs.recommended,
  ...tsEslint.configs.recommended,
  ...vuePlugin.configs["flat/essential"],

  // 3. TS / Vue files
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tsEslint.parser,
        ecmaVersion: "latest",
        sourceType: "module",
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      "no-console": "off",
      "no-debugger": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },

  // 4. Config / node-ish files
  {
    files: [
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.cjs",
      "vite.config.ts",
      "eslint.config.mjs",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);
