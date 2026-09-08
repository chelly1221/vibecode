import { describe, expect, it } from "vitest";
import { codeLooksValid, initialLogin, loginHint, reduceLogin, type LoginState } from "./loginFlow";

describe("login flow reducer", () => {
  it("walks started → browser → code → finished", () => {
    let s: LoginState = reduceLogin(initialLogin, { type: "started" });
    expect(s.phase).toBe("starting");
    s = reduceLogin(s, { type: "output", line: "Opening browser…" });
    s = reduceLogin(s, { type: "url", url: "https://claude.com/oauth?x=1" });
    expect(s.phase).toBe("browser");
    expect(s.url).toBe("https://claude.com/oauth?x=1");
    // A second URL does not replace the first.
    s = reduceLogin(s, { type: "url", url: "https://other" });
    expect(s.url).toBe("https://claude.com/oauth?x=1");
    s = reduceLogin(s, { type: "code_requested" });
    expect(s.phase).toBe("code");
    expect(loginHint(s)).toContain("인증 코드");
    s = reduceLogin(s, { type: "finished", code: 0, logged_in: true, account: "me@example.com" });
    expect(s.phase).toBe("finished");
    expect(loginHint(s)).toContain("me@example.com");
  });

  it("keeps only the last lines and reports failure", () => {
    let s: LoginState = reduceLogin(initialLogin, { type: "started" });
    for (let i = 0; i < 20; i++) s = reduceLogin(s, { type: "output", line: `l${i}` });
    expect(s.lines.length).toBe(12);
    expect(s.lines[0]).toBe("l8");
    s = reduceLogin(s, { type: "finished", code: 1, logged_in: false, account: null });
    expect(loginHint(s)).toContain("다시 시도");
    expect(codeLooksValid("abc")).toBe(false);
    expect(codeLooksValid("  a1b2c3d4e5#f6  ")).toBe(true);
  });
});
