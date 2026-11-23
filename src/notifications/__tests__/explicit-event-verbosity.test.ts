import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NotificationConfig } from "../types.js";

const mockDispatchNotifications = vi.fn();
vi.mock("../dispatcher.js", () => ({
  dispatchNotifications: (...args: unknown[]) => mockDispatchNotifications(...args),
  sendDiscord: vi.fn(),
  sendDiscordBot: vi.fn(),
  sendTelegram: vi.fn(),
  sendSlack: vi.fn(),
  sendSlackBot: vi.fn(),
  sendWebhook: vi.fn(),
}));

const mockGetNotificationConfig = vi.fn();
const mockIsEventEnabled = vi.fn();
const mockIsEventAllowedByVerbosity = vi.fn();
vi.mock("../config.js", () => ({
  getNotificationConfig: (profileName?: string) => mockGetNotificationConfig(profileName),
  isEventEnabled: (config: unknown, event: unknown) => mockIsEventEnabled(config, event),
  getVerbosity: () => "session",
  getTmuxTailLines: () => 15,
  isEventAllowedByVerbosity: (verbosity: unknown, event: unknown) =>
    mockIsEventAllowedByVerbosity(verbosity, event),
  shouldIncludeTmuxTail: () => false,
}));

vi.mock("../tmux.js", () => ({
  getCurrentTmuxSession: () => "test-tmux",
  getCurrentTmuxPaneId: () => "%99",
  getTeamTmuxSessions: () => [],
  formatTmuxInfo: () => null,
}));

vi.mock("../hook-config.js", () => ({
  getHookConfig: () => null,
  resolveEventTemplate: () => undefined,
  resetHookConfigCache: vi.fn(),
  mergeHookConfigIntoNotificationConfig: (_hook: unknown, config: unknown) => config,
}));

vi.mock("../session-registry.js", () => ({
  registerMessage: vi.fn(),
}));

import { notify } from "../index.js";
import { attentionNoticeText, sendAttentionNotice } from "../../factory/attention/notify.js";

const baseConfig: NotificationConfig = {
  enabled: true,
  webhook: {
    enabled: true,
    url: "https://example.test/webhook",
  },
};

describe("explicit event notification verbosity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockGetNotificationConfig.mockReturnValue(baseConfig);
    mockIsEventEnabled.mockReturnValue(true);
    mockIsEventAllowedByVerbosity.mockReturnValue(false);
    mockDispatchNotifications.mockResolvedValue({
      anySuccess: true,
      results: [{ platform: "webhook", success: true }],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps default session verbosity as a gate for ask-user-question when the event is not explicitly enabled", async () => {
    const result = await notify("ask-user-question", {
      sessionId: "sess-default-gated",
      question: "Continue?",
    });

    expect(result).toBeNull();
    expect(mockIsEventAllowedByVerbosity).toHaveBeenCalledWith(
      "session",
      "ask-user-question",
    );
    expect(mockDispatchNotifications).not.toHaveBeenCalled();
  });

  it("dispatches explicitly enabled ask-user-question even when default session verbosity would otherwise block it", async () => {
    mockGetNotificationConfig.mockReturnValue({
      ...baseConfig,
      events: {
        "ask-user-question": { enabled: true },
      },
    } satisfies NotificationConfig);

    const result = await notify("ask-user-question", {
      sessionId: "sess-explicit-ask",
      question: "Which option?",
    });

    expect(result).toEqual({
      anySuccess: true,
      results: [{ platform: "webhook", success: true }],
    });
    expect(mockIsEventAllowedByVerbosity).not.toHaveBeenCalled();
    expect(mockDispatchNotifications).toHaveBeenCalledOnce();
    expect(mockDispatchNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        events: { "ask-user-question": { enabled: true } },
      }),
      "ask-user-question",
      expect.objectContaining({
        event: "ask-user-question",
        sessionId: "sess-explicit-ask",
        question: "Which option?",
      }),
      undefined,
    );
  });
});

describe("factory-attention notification (omg factory poll)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNotificationConfig.mockReturnValue(baseConfig);
    mockIsEventEnabled.mockReturnValue(true);
    mockIsEventAllowedByVerbosity.mockReturnValue(true);
    mockDispatchNotifications.mockResolvedValue({ anySuccess: true, results: [{ platform: "webhook", success: true }] });
  });

  it("is not sent when the event is not enabled explicitly, even with top-level platforms on", async () => {
    expect(await notify("factory-attention", { sessionId: "factory-attention", message: "m" })).toBeNull();
    mockGetNotificationConfig.mockReturnValue({ ...baseConfig, events: { "factory-attention": { enabled: false } } } satisfies NotificationConfig);
    expect(await notify("factory-attention", { sessionId: "factory-attention", message: "m" })).toBeNull();
    expect(mockDispatchNotifications).not.toHaveBeenCalled();
  });

  it("is sent when enabled explicitly, whatever the verbosity, with no pane and no reply mapping", async () => {
    mockIsEventAllowedByVerbosity.mockReturnValue(false);
    mockGetNotificationConfig.mockReturnValue({ ...baseConfig, events: { "factory-attention": { enabled: true } } } satisfies NotificationConfig);
    const notice = { repo: "repo", key: "#6", group: "merge" as const, gate: "merge", next: "omg factory run 6" };
    await sendAttentionNotice(notice, notify as never);
    expect(mockDispatchNotifications).toHaveBeenCalledOnce();
    const payload = mockDispatchNotifications.mock.calls[0][2] as { message: string; tmuxPaneId: string; replyable: boolean; projectName: string; projectPath?: string };
    expect(payload).toMatchObject({ message: attentionNoticeText(notice), tmuxPaneId: "", replyable: false, projectName: "repo" });
    expect(payload.projectPath).toBeUndefined();
  });

  it("runs the message through the redaction", async () => {
    const sent: string[] = [];
    await sendAttentionNotice({ repo: "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", key: "#1", group: "fix", gate: null, next: null }, async (_e, d) => { sent.push(d.message); });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
  });
});
