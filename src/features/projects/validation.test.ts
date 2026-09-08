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

import { toDirName, validateDirName } from "./validation";

describe("dir names for tools", () => {
  it("derives ASCII slugs and rejects invalid ones", () => {
    expect(toDirName("My App 2")).toBe("my-app-2");
    expect(toDirName("재고관리")).toBe("");
    expect(toDirName("재고 app")).toBe("app");
    expect(validateDirName("inventory-app")).toBeNull();
    expect(validateDirName("재고")).not.toBeNull();
    expect(validateDirName("-bad")).not.toBeNull();
    for (const name of ["con.txt", "aux.log", "com1", "lpt9.backup", "app.", "_app", "MyApp"]) {
      expect(validateDirName(name)).not.toBeNull();
    }
    expect(validateDirName("a".repeat(65))).not.toBeNull();
    expect(validateProjectName("bad\nname")).not.toBeNull();
    expect(validateProjectName("가".repeat(100))).toBeNull();
    expect(validateProjectName("재고 관리 앱")).toBeNull();
  });
});
