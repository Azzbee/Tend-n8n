import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        Bun: "readonly",
        console: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
