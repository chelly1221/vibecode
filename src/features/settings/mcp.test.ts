import { describe, expect, it } from "vitest";
import { formatEnv, joinArgs, newServer, parseEnv, splitArgs, validateServer } from "./mcp";

describe("mcp helpers", () => {
  it("splits args with quotes", () => {
    expect(splitArgs('-y @scope/pkg --root "C:\\my dir" \'a b\' plain')).toEqual(["-y", "@scope/pkg", "--root", "C:\\my dir", "a b", "plain"]);
    expect(splitArgs("  ")).toEqual([]);
    expect(splitArgs('""')).toEqual([""]);
    expect(joinArgs(["a b", "c"])).toBe('"a b" c');
  });
  it("parses env lines", () => {
    expect(parseEnv("A=1\n# c\n\nB = x=y\nbad")).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "x=y" },
    ]);
    expect(formatEnv([{ key: "A", value: "1" }])).toBe("A=1");
  });
  it("validates servers", () => {
    const s = newServer();
    expect(validateServer(s, [])).toMatch(/이름/);
    s.name = "bad name";
    expect(validateServer(s, [])).toMatch(/영문/);
    s.name = "fs";
    expect(validateServer(s, [])).toMatch(/명령/);
    s.command = "npx";
    expect(validateServer(s, [])).toBeNull();
    s.transport = "http";
    expect(validateServer(s, [])).toMatch(/URL/);
    s.url = "https://x.dev/mcp";
    expect(validateServer(s, [])).toBeNull();
    expect(validateServer(s, [{ ...newServer(), name: "fs" }])).toMatch(/이미/);
  });
});
