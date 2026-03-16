/**
 * Tests for non-Copilot provider auto-detection (issue #1201)
 * and Bedrock/Vertex AI auto-detection
 *
 * When CC Switch or similar tools route requests to non-Copilot providers,
 * or when running on AWS Bedrock or Google Vertex AI, OMG should
 * auto-enable forceInherit to avoid passing Copilot-specific model tier
 * names (sonnet/opus/haiku) that cause 400 errors.
 */
export {};
//# sourceMappingURL=non-claude-provider-detection.test.d.ts.map