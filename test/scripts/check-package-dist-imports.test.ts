import { describe, expect, it } from "vitest";
import { collectPackageDistImportErrors } from "../../scripts/lib/package-dist-imports.mjs";

describe("check-package-dist-imports", () => {
  it("reproduces stale memory-core dist chunks that import a missing runtime provider", () => {
    expect(
      collectPackageDistImportErrors({
        files: ["dist/extensions/memory-core/index.js"],
        readText(relativePath) {
          if (relativePath === "dist/extensions/memory-core/index.js") {
            return 'runtimeProviderModulePromise ??= import("../../runtime-provider-D5Q2QPqe.js");\n';
          }
          return "";
        },
      }),
    ).toEqual([
      "dist/extensions/memory-core/index.js imports missing dist/runtime-provider-D5Q2QPqe.js",
    ]);
  });
});
