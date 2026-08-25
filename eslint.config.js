import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly", __dirname: "readonly" },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    // The domain layer must stay pure: no IO, no LLM, no framework.
    files: ["packages/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "node:*",
            "pg",
            "ioredis",
            "bullmq",
            "fastify",
            "axios",
            "undici",
            "playwright",
            "openai",
            "@procurement/observability",
          ],
        },
      ],
    },
  },
  {
    files: ["packages/observability/**/*.ts"],
    rules: { "no-console": "off" },
  },
);
