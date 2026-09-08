import { describe, expect, it } from "vitest";
import { installCommand, loginCommand, shellCommand } from "./commands";

describe("terminal commands", () => {
  it("builds login commands per provider", () => {
    expect(loginCommand("claude")).toEqual({ program: "claude", args: [], title: "Claude 로그인" });
    expect(loginCommand("codex").args).toEqual(["login"]);
  });

  it("keeps PowerShell open after an install hint", () => {
    const cmd = installCommand("irm https://claude.ai/install.ps1 | iex");
    expect(cmd.program).toBe("powershell.exe");
    expect(cmd.args).toContain("-NoExit");
    expect(cmd.args.at(-1)).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("shell command has no program", () => {
    expect(shellCommand().program).toBeNull();
  });
});
