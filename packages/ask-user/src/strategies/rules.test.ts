import { describe, expect, test } from "bun:test";
import { createRulesStrategy } from "./rules.js";

const DEFAULT_RULES = {
  prefer: "simpler" as const,
  defaultResponse: "Proceed with the simpler, more conventional approach.",
};

describe("createRulesStrategy", () => {
  describe("with options", () => {
    test("picks shorter option when prefer=simpler and no keywords match", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({
        question: "Which approach?",
        options: ["Use a complex factory pattern", "Use a function"],
      });
      return expect(result).resolves.toBe("Use a function");
    });

    test("picks option with simpler keyword when prefer=simpler", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({
        question: "Which approach?",
        options: ["Use the complex approach with caching", "Use the simpler direct approach"],
      });
      return expect(result).resolves.toBe("Use the simpler direct approach");
    });

    test("picks option with existing keyword when prefer=existing", () => {
      const strategy = createRulesStrategy({ ...DEFAULT_RULES, prefer: "existing" });
      const result = strategy.answer({
        question: "Which pattern?",
        options: ["Rewrite from scratch", "Keep existing pattern"],
      });
      return expect(result).resolves.toBe("Keep existing pattern");
    });

    test("picks first option when prefer=first", () => {
      const strategy = createRulesStrategy({ ...DEFAULT_RULES, prefer: "first" });
      const result = strategy.answer({
        question: "Pick one",
        options: ["Alpha", "Beta", "Gamma"],
      });
      return expect(result).resolves.toBe("Alpha");
    });

    test("handles single option", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({
        question: "Confirm?",
        options: ["Yes"],
      });
      return expect(result).resolves.toBe("Yes");
    });

    test("handles empty options array as no-options case", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({
        question: "Should I proceed?",
        options: [],
      });
      // Empty options = no options, returns default (does NOT auto-approve)
      return expect(result).resolves.toBe(DEFAULT_RULES.defaultResponse);
    });
  });

  describe("without options — always returns default response", () => {
    test("returns default for 'should I' questions (does not auto-approve)", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({ question: "Should I drop the backup table?" });
      return expect(result).resolves.toBe(DEFAULT_RULES.defaultResponse);
    });

    test("returns default for 'do you want' questions", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({ question: "Do you want me to delete all logs?" });
      return expect(result).resolves.toBe(DEFAULT_RULES.defaultResponse);
    });

    test("returns default for 'can I' questions (does not auto-approve)", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({ question: "Can I remove the production database?" });
      return expect(result).resolves.toBe(DEFAULT_RULES.defaultResponse);
    });

    test("returns default for open-ended questions", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({
        question: "What database technology would you recommend?",
      });
      return expect(result).resolves.toBe(DEFAULT_RULES.defaultResponse);
    });

    test("uses custom default response", () => {
      const strategy = createRulesStrategy({
        ...DEFAULT_RULES,
        defaultResponse: "Just pick the best one.",
      });
      const result = strategy.answer({ question: "What framework?" });
      return expect(result).resolves.toBe("Just pick the best one.");
    });
  });

  describe("edge cases", () => {
    test("handles unicode in question", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({
        question: "Which emoji? \u{1F680}",
        options: ["rocket", "star"],
      });
      // picks shorter option
      return expect(result).resolves.toBe("star");
    });

    test("handles very long question", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const longQ = "What database technology would you recommend for this project? ".repeat(200);
      const result = strategy.answer({ question: longQ });
      return expect(result).resolves.toBe(DEFAULT_RULES.defaultResponse);
    });

    test("strategy name is 'rules'", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      expect(strategy.name).toBe("rules");
    });
  });
});
