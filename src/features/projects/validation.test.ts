import { describe, expect, it } from "vitest";
import { joinPath, pathWarnings, validateProjectName } from "./validation";

describe("validateProjectName", () => {
  it("accepts ordinary names", () => {
    expect(validateProjectName("my-app")).toBeNull();
    expect(validateProjectName("my_app2")).toBeNull();
  });
  it("rejects empty and forbidden characters", () => {
    expect(validateProjectName("")).not.toBeNull();
    expect(validateProjectName("   ")).not.toBeNull();
    for (const ch of ['\\', "/", ":", "*", "?", '"', "<", ">", "|"]) {
      expect(validateProjectName(`a${ch}b`)).not.toBeNull();
    }
  });
  it("rejects reserved names, trailing dots and surrounding spaces", () => {
    expect(validateProjectName("CON")).not.toBeNull();
    expect(validateProjectName("app.")).not.toBeNull();
    expect(validateProjectName(" app")).not.toBeNull();
  });
});

describe("joinPath", () => {
  it("uses backslashes for Windows parents", () => {
    expect(joinPath("C:\\code", "app")).toBe("C:\\code\\app");
    expect(joinPath("C:\\code\\", "app")).toBe("C:\\code\\app");
    expect(joinPath("C:", "app")).toBe("C:\\app");
  });
  it("keeps forward slashes for POSIX parents", () => {
    expect(joinPath("/home/me/", "app")).toBe("/home/me/app");
  });
  it("returns the name when parent is empty", () => {
    expect(joinPath("", "app")).toBe("app");
  });
});

describe("pathWarnings", () => {
  it("flags spaces and non-ascii", () => {
    expect(pathWarnings("C:\\my code\\app").map((w) => w.kind)).toEqual(["space"]);
    expect(pathWarnings("C:\\코드\\app").map((w) => w.kind)).toEqual(["non_ascii"]);
    expect(pathWarnings("C:\\code\\app")).toEqual([]);
  });
});
