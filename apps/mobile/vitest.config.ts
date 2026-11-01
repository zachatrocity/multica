import { defineConfig } from "vitest/config";
import path from "node:path";
import {
  JsxEmit,
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript";

// Mobile Vitest stays in Node: pure helpers, headless data logic, and focused
// component interaction tests with native host components mocked. It does not
// use a DOM or pretend that browser rendering matches React Native. The issue
// menu regression test uses React's renderer to exercise the real RNR dropdown
// state and portal lifecycle on an Android platform shim.
//
// Data-layer tests must mock `@/data/api` so the native fetch chain never
// loads.
//
// Co-located test files (foo.ts + foo.test.ts) match how the rest of the
// monorepo organises vitest suites.
// The run cancel button has headless callback/prop tests with native modules
// mocked; these do not verify native rendering.
// App configuration tests also run here to cover native prebuild options
// across environment variants without loading React Native.
const transformReactNativePrimitiveJsx = {
  name: "transform-react-native-primitive-jsx",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    const sourcePath = id.split("?")[0];
    if (
      !sourcePath.includes("/@rn-primitives") ||
      !/\.[mc]?js$/.test(sourcePath)
    ) {
      return;
    }
    return transpileModule(code, {
      compilerOptions: {
        jsx: JsxEmit.ReactJSX,
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
      },
      fileName: `${sourcePath}.tsx`,
    }).outputText;
  },
};

export default defineConfig({
  plugins: [transformReactNativePrimitiveJsx],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: [
      "app.config.test.ts",
      "lib/**/*.test.ts",
      "data/**/*.test.ts",
      "components/issue/run-cancel-button.test.ts",
      "components/issue/issue-actions-menu.test.ts",
    ],
    server: {
      deps: {
        inline: [/@rn-primitives\//],
      },
    },
    passWithNoTests: true,
  },
});
