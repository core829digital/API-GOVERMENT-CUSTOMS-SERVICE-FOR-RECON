import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import react from "eslint-plugin-react";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  globalIgnores([".next/**", "node_modules/**", "next-env.d.ts", "playwright-report/**", "test-results/**"]),
  {
    // R-FE-3: no hard-coded user-facing strings in JSX. Strings must come from the i18n catalogs.
    files: ["app/**/*.tsx", "components/**/*.tsx"],
    plugins: { react },
    rules: {
      "react/jsx-no-literals": ["error", { noStrings: false, allowedStrings: [":", "/", "·", "—", "–"] }],
    },
  },
]);
