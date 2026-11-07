/**
 * Data Loss Prevention (DLP) & Secret Redactor
 *
 * Scans outgoing user prompts for accidentally included sensitive credentials (API keys,
 * private keys, database passwords) and replaces them with safe redacted tokens before sending
 * to upstream LLMs, protecting against data leakage and compromised accounts.
 */

const SECRET_PATTERNS = [
  {
    type: "ANTHROPIC_KEY",
    regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
  },
  {
    type: "OPENAI_KEY",
    regex: /\bsk-(?!ant-)(?:proj-|live-)?[a-zA-Z0-9_-]{20,}\b/g,
  },
  {
    type: "GOOGLE_API_KEY",
    regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  },
  {
    type: "GITHUB_TOKEN",
    regex: /\b(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})\b/g,
  },
  {
    type: "AWS_ACCESS_KEY",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    type: "PRIVATE_KEY",
    regex: /-----BEGIN (?:[A-Z0-9 ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+)?PRIVATE KEY-----/g,
  },
  {
    type: "DB_PASSWORD",
    regex: /((?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^:\s\/]+:)([^@\s\/]+)(@)/gi,
    isUriReplacer: true,
  },
];

/**
 * Checks whether DLP redaction is enabled (default: true)
 */
export function isDlpEnabled() {
  return process.env.DLP_REDACT_ENABLED !== "false" && process.env.DLP_REDACT_ENABLED !== "0";
}

/**
 * Redacts secrets from a plain text string
 *
 * @param {string} text
 * @returns {{ text: string, redactedCount: number, redactedTypes: string[] }}
 */
export function redactSecretsInText(text) {
  if (typeof text !== "string" || !text) {
    return { text, redactedCount: 0, redactedTypes: [] };
  }

  let redactedCount = 0;
  const redactedTypes = new Set();
  let result = text;

  for (const { type, regex, isUriReplacer } of SECRET_PATTERNS) {
    if (isUriReplacer) {
      result = result.replace(regex, (match, prefix, password, suffix) => {
        redactedCount++;
        redactedTypes.add(type);
        return `${prefix}[REDACTED_SECRET:${type}]${suffix}`;
      });
    } else {
      result = result.replace(regex, () => {
        redactedCount++;
        redactedTypes.add(type);
        return `[REDACTED_SECRET:${type}]`;
      });
    }
  }

  return {
    text: result,
    redactedCount,
    redactedTypes: Array.from(redactedTypes),
  };
}

/**
 * Redacts secrets across all messages in a chat body
 *
 * @param {object} body - Chat request body
 * @returns {{ body: object, redactedCount: number, redactedTypes: string[] }}
 */
export function redactSecretsInBody(body = {}) {
  if (!isDlpEnabled() || !body || !Array.isArray(body.messages)) {
    return { body, redactedCount: 0, redactedTypes: [] };
  }

  let totalRedacted = 0;
  const allTypes = new Set();

  const newMessages = body.messages.map((m) => {
    let content = m?.content;
    if (typeof content === "string") {
      const red = redactSecretsInText(content);
      if (red.redactedCount > 0) {
        totalRedacted += red.redactedCount;
        red.redactedTypes.forEach((t) => allTypes.add(t));
        content = red.text;
      }
    } else if (Array.isArray(content)) {
      content = content.map((part) => {
        if (typeof part === "string") {
          const red = redactSecretsInText(part);
          if (red.redactedCount > 0) {
            totalRedacted += red.redactedCount;
            red.redactedTypes.forEach((t) => allTypes.add(t));
            return red.text;
          }
          return part;
        }
        if (part?.type === "text" && typeof part.text === "string") {
          const red = redactSecretsInText(part.text);
          if (red.redactedCount > 0) {
            totalRedacted += red.redactedCount;
            red.redactedTypes.forEach((t) => allTypes.add(t));
            return { ...part, text: red.text };
          }
        }
        return part;
      });
    }

    return {
      ...m,
      content,
    };
  });

  return {
    body: totalRedacted > 0 ? { ...body, messages: newMessages } : body,
    redactedCount: totalRedacted,
    redactedTypes: Array.from(allTypes),
  };
}
