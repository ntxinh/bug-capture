import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsStorage } from "../src/local";

describe("LocalFsStorage", () => {
  it("createUpload→write→head→delete round-trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "storage-"));
    const s = new LocalFsStorage(root, "http://x");
    const t = await s.createUpload("r1", "a1", "replay", 4, "0".repeat(64));
    await s.write("r1", t.key, new TextEncoder().encode("abcd").buffer);
    expect(await s.head("r1", t.key)).toEqual({ sizeBytes: 4 });
    expect(t.url).toBe("http://x/api/v1/uploads/r1/a1-replay");
    expect(await s.getDownloadUrl("r1", t.key)).toBe(
      "http://x/api/v1/uploads/r1/a1-replay",
    );
    await s.delete("r1", t.key);
    expect(await s.head("r1", t.key)).toBeNull();
  });
});
