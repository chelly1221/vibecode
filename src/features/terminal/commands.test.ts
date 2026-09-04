import { describe, expect, it } from "vitest";
import { installCommand, loginCommand, shellCommand } from "./commands";

describe("terminal commands", () => {
  it("builds login commands per provider", () => {
    expect(loginCommand("claude")).toEqual({ program: "claude", args: [], title: "Claude 로그인" });
    expect(loginCommand("codex").args).toEqual(["login"]);
  });

  it("keeps the shell open after an install hint", () => {
    const wsl = installCommand("curl -fsSL https://claude.ai/install.sh | bash", "wsl");
    expect(wsl.program).toBe("bash");
    expect(wsl.args[0]).toBe("-lc");
    expect(wsl.args[1]).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(wsl.args[1]).toMatch(/exec bash -l$/);

    const native = installCommand("irm https://claude.ai/install.ps1 | iex", "native");
    expect(native.program).toBe("powershell.exe");
    expect(native.args).toContain("-NoExit");
    expect(native.args.at(-1)).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("shell command has no program", () => {
    expect(shellCommand().program).toBeNull();
  });
});
