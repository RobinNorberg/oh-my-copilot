/**
 * Tests for session-scoped idle notification cooldown.
 * Verifies each session has independent cooldown state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  shouldSendIdleNotification,
  recordIdleNotificationSent,
  getIdleNotificationCooldownSeconds,
} from "./index.js";

describe("idle notification cooldown (issue #842)", () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "idle-cooldown-test-"));
    stateDir = join(tempDir, ".omg", "state");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("shouldSendIdleNotification", () => {
    it("returns true when no cooldown file exists", () => {
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });

    it("returns false when cooldown file was written recently", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      writeFileSync(
        cooldownPath,
        JSON.stringify({ lastSentAt: new Date().toISOString() })
      );
      expect(shouldSendIdleNotification(stateDir)).toBe(false);
    });

    it("returns true when cooldown file timestamp is past the cooldown window", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      // Write a timestamp 2 minutes in the past (default cooldown is 60s)
      const past = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: past }));
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });

    it("returns true when cooldown file contains invalid JSON", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      writeFileSync(cooldownPath, "{ not valid json");
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });

    it("returns true when cooldown file is missing lastSentAt field", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      writeFileSync(cooldownPath, JSON.stringify({ other: "field" }));
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });

    it("uses session-scoped cooldown path when sessionId is provided", () => {
      const sessionId = "session-abc";
      const cooldownPath = join(
        stateDir,
        "sessions",
        sessionId,
        "idle-notif-cooldown.json"
      );
      mkdirSync(dirname(cooldownPath), { recursive: true });
      writeFileSync(
        cooldownPath,
        JSON.stringify({ lastSentAt: new Date().toISOString() })
      );

      expect(shouldSendIdleNotification(stateDir, sessionId)).toBe(false);
      expect(shouldSendIdleNotification(stateDir, "different-session")).toBe(true);
    });
  });

  describe("recordIdleNotificationSent", () => {
    it("creates cooldown file with lastSentAt timestamp", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      expect(existsSync(cooldownPath)).toBe(false);

      recordIdleNotificationSent(stateDir);

      expect(existsSync(cooldownPath)).toBe(true);
      const data = JSON.parse(readFileSync(cooldownPath, "utf-8")) as Record<string, unknown>;
      expect(typeof data.lastSentAt).toBe("string");
      const ts = new Date(data.lastSentAt as string).getTime();
      expect(Number.isFinite(ts)).toBe(true);
      expect(ts).toBeGreaterThan(Date.now() - 5000);
    });

    it("overwrites an existing cooldown file", () => {
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      const old = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: old }));

      recordIdleNotificationSent(stateDir);

      const data = JSON.parse(readFileSync(cooldownPath, "utf-8")) as Record<string, unknown>;
      expect(new Date(data.lastSentAt as string).getTime()).toBeGreaterThan(
        new Date(old).getTime()
      );
    });

    it("creates intermediate directories if they do not exist", () => {
      const deepStateDir = join(tempDir, "new", "deep", ".omg", "state");
      expect(existsSync(deepStateDir)).toBe(false);

      recordIdleNotificationSent(deepStateDir);

      expect(existsSync(join(deepStateDir, "idle-notif-cooldown.json"))).toBe(true);
    });

    it("writes to session-scoped path when sessionId is provided", () => {
      const sessionId = "session-xyz";
      const cooldownPath = join(
        stateDir,
        "sessions",
        sessionId,
        "idle-notif-cooldown.json"
      );
      expect(existsSync(cooldownPath)).toBe(false);

      recordIdleNotificationSent(stateDir, sessionId);

      expect(existsSync(cooldownPath)).toBe(true);
      expect(existsSync(join(stateDir, "idle-notif-cooldown.json"))).toBe(false);
    });
  });

  describe("cooldown integration: send → suppress → send after expiry", () => {
    it("suppresses second notification within cooldown window", () => {
      // First call: no cooldown file → should send
      expect(shouldSendIdleNotification(stateDir)).toBe(true);
      recordIdleNotificationSent(stateDir);

      // Second call immediately after: within cooldown window → should NOT send
      expect(shouldSendIdleNotification(stateDir)).toBe(false);
    });

    it("allows notification again after cooldown expires", () => {
      // Simulate a cooldown file written 2 minutes ago (past default 60s window)
      const cooldownPath = join(stateDir, "idle-notif-cooldown.json");
      const past = new Date(Date.now() - 120_000).toISOString();
      writeFileSync(cooldownPath, JSON.stringify({ lastSentAt: past }));

      expect(shouldSendIdleNotification(stateDir)).toBe(true);
    });
  });

  describe("getIdleNotificationCooldownSeconds", () => {
    it("returns a non-negative number", () => {
      const val = getIdleNotificationCooldownSeconds();
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(0);
    });
  });
});
