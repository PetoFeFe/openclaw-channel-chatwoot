import { describe, expect, it } from "vitest";
import { parseHandoffDirective, stripHandoffDirective } from "../src/directive.js";

describe("handoff directive", () => {
  it("returns undefined when no directive is present", () => {
    expect(parseHandoffDirective("Ola! Como posso ajudar?")).toBeUndefined();
    expect(parseHandoffDirective("")).toBeUndefined();
  });

  it("ignores prose that merely mentions handoff", () => {
    expect(
      parseHandoffDirective("Vou fazer o handoff para a equipe agora mesmo, um instante.")
    ).toBeUndefined();
  });

  it("parses a directive with team and reason and strips it from the notice", () => {
    const text =
      "Vou encaminhar seu pedido para a administracao, tudo bem?\n[[chatwoot-handoff team=2 reason=cliente pediu administracao]]";
    const parsed = parseHandoffDirective(text);
    expect(parsed).toEqual({
      notice: "Vou encaminhar seu pedido para a administracao, tudo bem?",
      teamId: "2",
      reason: "cliente pediu administracao"
    });
  });

  it("supports a directive-only reply (empty notice)", () => {
    const parsed = parseHandoffDirective("[[chatwoot-handoff team=1 reason=hc-missing]]");
    expect(parsed).toEqual({ notice: "", teamId: "1", reason: "hc-missing" });
  });

  it("is case-insensitive and accepts quoted team ids", () => {
    const parsed = parseHandoffDirective('[[ CHATWOOT-HANDOFF team="2" reason=refund ]]');
    expect(parsed).toEqual({ notice: "", teamId: "2", reason: "refund" });
  });

  it("tolerates a directive with no attributes", () => {
    const parsed = parseHandoffDirective("Um instante.\n[[chatwoot-handoff]]");
    expect(parsed).toEqual({ notice: "Um instante.", teamId: undefined, reason: undefined });
  });

  it("stripHandoffDirective removes only directive lines", () => {
    const text = "linha 1\n[[chatwoot-handoff team=1]]\nlinha 2";
    expect(stripHandoffDirective(text)).toBe("linha 1\nlinha 2");
  });
});
