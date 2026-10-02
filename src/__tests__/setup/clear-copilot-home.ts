// A developer's exported COPILOT_HOME would redirect every config-dir lookup,
// breaking tests that assume the ~/.copilot default. Tests that need it set it.
delete process.env.COPILOT_HOME;
