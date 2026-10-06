import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const doctorConflictsCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../commands/doctor-conflicts.js', () => ({
  doctorConflictsCommand: doctorConflictsCommandMock,
}));

const originalSkipParse = process.env.OMC_CLI_SKIP_PARSE;
process.env.OMC_CLI_SKIP_PARSE = '1';

async function parseDoctor(args: string[]): Promise<void> {
  vi.resetModules();
  const { buildProgram } = await import('../index.js');
  await buildProgram().parseAsync(['node', 'omc', ...args]);
}

describe('doctor conflicts Commander integration', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    doctorConflictsCommandMock.mockReset();
    doctorConflictsCommandMock.mockResolvedValue(0);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  afterAll(() => {
    if (originalSkipParse === undefined) delete process.env.OMC_CLI_SKIP_PARSE;
    else process.env.OMC_CLI_SKIP_PARSE = originalSkipParse;
  });

  it('dispatches doctor conflicts --json with json:true (regression: was shadowed by the parent doctor command\'s own --json option)', async () => {
    await parseDoctor(['doctor', 'conflicts', '--json']);

    expect(doctorConflictsCommandMock).toHaveBeenCalledWith({ json: true });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('dispatches doctor conflicts without --json as json:false', async () => {
    await parseDoctor(['doctor', 'conflicts']);

    expect(doctorConflictsCommandMock).toHaveBeenCalledWith({ json: false });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('propagates the command exit code for doctor conflicts --json', async () => {
    doctorConflictsCommandMock.mockResolvedValueOnce(1);

    await parseDoctor(['doctor', 'conflicts', '--json']);

    expect(doctorConflictsCommandMock).toHaveBeenCalledWith({ json: true });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
