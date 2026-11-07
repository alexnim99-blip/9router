import { describe, it, expect } from "vitest";
import {
  estimateTokenCount,
  resolveModelContextLimit,
  pruneContextIfNeeded,
} from "../../open-sse/services/contextPruner.js";

describe("Adaptive Context Window Pruning", () => {
  it("estimates token count proportional to message length", () => {
    const messages = [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "user", content: "Write a function to sort numbers in JavaScript." },
    ];
    const tokens = estimateTokenCount(messages);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(100);
  });

  it("resolves context limit for standard models", () => {
    expect(resolveModelContextLimit("claude-3-5-sonnet")).toBe(200000);
    expect(resolveModelContextLimit("gpt-4o")).toBe(128000);
    expect(resolveModelContextLimit("gemini-1.5-pro")).toBe(1000000);
  });

  it("leaves conversations untouched when below context limit", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "Instructions" },
        { role: "user", content: "Short query" },
      ],
    };

    const res = pruneContextIfNeeded(body, 10000);
    expect(res.pruned).toBe(false);
    expect(res.body.messages.length).toBe(2);
  });

  it("prunes middle dialogue turns when exceeding limit while keeping system, 1st turn, and recent turns", () => {
    const longText = "A".repeat(500);
    const messages = [
      { role: "system", content: "CRITICAL_SYSTEM_PROMPT" },
      { role: "user", content: "INITIAL_USER_TURN" },
      // 10 middle turns
      { role: "assistant", content: "Middle 1: " + longText },
      { role: "user", content: "Middle 2: " + longText },
      { role: "assistant", content: "Middle 3: " + longText },
      { role: "user", content: "Middle 4: " + longText },
      { role: "assistant", content: "Middle 5: " + longText },
      { role: "user", content: "Middle 6: " + longText },
      { role: "assistant", content: "Middle 7: " + longText },
      { role: "user", content: "Middle 8: " + longText },
      // Recent turns
      { role: "assistant", content: "RECENT_ASSISTANT_1" },
      { role: "user", content: "RECENT_USER_1" },
      { role: "assistant", content: "RECENT_ASSISTANT_2" },
      { role: "user", content: "LATEST_USER_QUERY" },
    ];

    const body = { model: "test-model", messages };
    // Force small limit of 500 tokens to trigger pruning
    const res = pruneContextIfNeeded(body, 500, { minRecentTurns: 4 });

    expect(res.pruned).toBe(true);
    expect(res.savedTokens).toBeGreaterThan(0);

    const prunedRoles = res.body.messages.map((m) => m.role);
    expect(prunedRoles).toContain("system");

    // Verify system prompt preserved
    expect(res.body.messages[0].content).toBe("CRITICAL_SYSTEM_PROMPT");
    // Verify initial user turn preserved
    expect(res.body.messages[1].content).toBe("INITIAL_USER_TURN");
    // Verify notice inserted
    expect(res.body.messages[2].content).toContain("Notice from 9Router Gateway: Pruned");
    // Verify latest turn preserved
    expect(res.body.messages[res.body.messages.length - 1].content).toBe("LATEST_USER_QUERY");
  });
});
