import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inheritedPythonLsp = process.env.OMC_PYTHON_LSP;

// The PATH resolver treats a finder run as successful only when it exits zero
// AND prints an absolute path, so a stubbed hit has to supply both.
const FINDER_HIT_PATH = process.platform === 'win32' ? 'C:\\tools\\bin\\' : '/usr/local/bin/';

async function renderServerStatus(installedCommand?: string): Promise<string> {
  vi.resetModules();
  vi.doMock('child_process', () => ({
    spawnSync: vi.fn((_command: string, args: string[]) =>
      args[0] === installedCommand
        ? { status: 0, stdout: `${FINDER_HIT_PATH}${args[0]}\n` }
        : { status: 1, stdout: '' }
    )
  }));

  const { lspServersTool } = await import('../tools/lsp-tools.js');
  const rendered = await lspServersTool.handler({});
  return rendered.content[0].text;
}

beforeEach(() => {
  delete process.env.OMC_PYTHON_LSP;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('child_process');
  vi.resetModules();
});

afterAll(() => {
  if (inheritedPythonLsp === undefined) {
    delete process.env.OMC_PYTHON_LSP;
  } else {
    process.env.OMC_PYTHON_LSP = inheritedPythonLsp;
  }
});

describe('Python LSP catalog selection', () => {
  it('renders only the selected missing basedpyright server and install hint', async () => {
    vi.stubEnv('OMC_PYTHON_LSP', 'basedpyright');

    const text = await renderServerStatus();

    expect(text).toContain('### Not Installed:');
    expect(text).toContain('- Python Language Server (basedpyright) (basedpyright-langserver)');
    expect(text).toContain('Extensions: .py, .pyw');
    expect(text).toContain('Install: uv tool install basedpyright');
    expect(text).not.toContain('Python Language Server (ty)');
  });

  it('renders only the default installed ty server', async () => {
    delete process.env.OMC_PYTHON_LSP;

    const text = await renderServerStatus('ty');

    expect(text).toContain('### Installed:');
    expect(text).toContain('- Python Language Server (ty) (ty)');
    expect(text).not.toContain('Python Language Server (basedpyright)');
    expect(text).not.toContain('Install: uv tool install basedpyright');
  });

  it('renders only the default missing ty server and install hint', async () => {
    const text = await renderServerStatus();

    expect(text).toContain('### Not Installed:');
    expect(text).toContain('- Python Language Server (ty) (ty)');
    expect(text).toContain('Install: Install ty from https://github.com/astral-sh/ty');
    expect(text).not.toContain('Python Language Server (basedpyright)');
    expect(text).not.toContain('Install: uv tool install basedpyright');
  });
});
