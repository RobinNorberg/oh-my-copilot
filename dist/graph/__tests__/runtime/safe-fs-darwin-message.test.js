import { afterEach, describe, expect, it, vi } from "vitest";
const loaderError = new Error("The contained filesystem backend is unavailable at /pkg/native/contained-fs-darwin-arm64.node. Build it with node scripts/build-contained-fs.mjs (from the installed package directory) before running graph or team commands.");
vi.mock("../../runtime/native-contained-fs.js", () => ({
    getNativeContainedFs: () => { throw loaderError; },
}));
import { assertContainedFsSupported } from "../../runtime/safe-fs.js";
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
describe("assertContainedFsSupported on darwin without the addon", () => {
    afterEach(() => {
        Object.defineProperty(process, "platform", realPlatform);
    });
    it("keeps the loader message naming the build script and fails closed", () => {
        Object.defineProperty(process, "platform", { ...realPlatform, value: "darwin" });
        let thrown;
        try {
            assertContainedFsSupported("darwin");
        }
        catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const error = thrown;
        expect(error.message).toContain("contained directory-FD traversal is unavailable on darwin; refusing pathname fallback");
        expect(error.message).toContain("scripts/build-contained-fs.mjs");
        expect(error.cause).toBe(loaderError);
    });
});
//# sourceMappingURL=safe-fs-darwin-message.test.js.map