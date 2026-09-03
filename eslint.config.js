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
    files: ["**/*.ts", "**/*.tsx"],
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
  {
    files: ["packages/db/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["fastify", "bullmq", "playwright", "openai", "apps/*", "mcp/*", "workers/*"],
        },
      ],
    },
  },
  {
    files: ["packages/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["playwright", "fastify", "bullmq"],
        },
      ],
    },
  },
  {
    files: ["mcp/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@procurement/db",
              message: "MCP adapters must not read the database.",
            },
            {
              name: "@procurement/application",
              message: "MCP adapters receive a SearchQuery, not application use cases.",
            },
          ],
          patterns: ["@procurement/db", "@procurement/application", "apps/*", "workers/*"],
        },
      ],
    },
  },
  {
    files: ["packages/mcp-client/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@procurement/db",
            "@procurement/application",
            "mcp/*",
            "apps/*",
            "workers/*",
          ],
        },
      ],
    },
  },
  {
    files: ["apps/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@procurement/db",
              message: "This slice uses an in-memory specialist catalog, not PostgreSQL.",
            },
          ],
          patterns: ["@procurement/db", "mcp/*", "apps/web", "playwright", "bullmq"],
        },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@procurement/db",
              message: "The web console reads the specialist HTTP API, not the database.",
            },
          ],
          patterns: [
            "@procurement/db",
            "mcp/*",
            "apps/agent-runtime",
            "apps/api",
            "playwright",
            "fastify",
            "bullmq",
          ],
        },
      ],
    },
  },
  {
    files: ["apps/agent-runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@procurement/db",
              message: "Agent runtime must not read the database.",
            },
          ],
          patterns: ["@procurement/db", "mcp/*", "playwright", "fastify", "bullmq"],
        },
      ],
    },
  },
  {
    files: ["workers/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["apps/*", "playwright"],
        },
      ],
    },
  },
);
