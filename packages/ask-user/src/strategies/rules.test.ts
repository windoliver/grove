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
      return expect(result).resolves.toBe("Yes");
    });
  });

  describe("without options", () => {
    test("answers yes for 'should I' questions", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({ question: "Should I refactor this module?" });
      return expect(result).resolves.toBe("Yes");
    });

    test("answers yes for 'do you want' questions", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({ question: "Do you want me to add tests?" });
      return expect(result).resolves.toBe("Yes");
    });

    test("answers yes for 'shall I' questions", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({ question: "Shall I continue?" });
      return expect(result).resolves.toBe("Yes");
    });

    test("answers yes for 'is it ok' questions", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({ question: "Is it ok to delete the old file?" });
      return expect(result).resolves.toBe("Yes");
    });

    test("answers yes for 'can I' questions", () => {
      const strategy = createRulesStrategy(DEFAULT_RULES);
      const result = strategy.answer({ question: "Can I use TypeScript here?" });
      return expect(result).resolves.toBe("Yes");
    });

    test("returns default response for open-ended questions", () => {
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
        question: "Should I add emoji support? \u{1F680}",
      });
      return expect(result).resolves.toBe("Yes");
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
