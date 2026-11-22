/**
 * NuGet restore for a dotnet gate (engine.ts ensureLocalGate). Deterministic,
 * no LLM, no network: the classifier reads the error codes NuGet prints, the
 * rest names fixed paths and arguments.
 *
 * Every dotnet gate first runs offline in the OS sandbox, with the NuGet
 * global packages folder granted read-only. When it fails restoring
 * (classifyNugetFailure), the failure is never a code failure (no ci-fix
 * lane, which has no network and could never fix it): with
 * factory.run.gateInstall "sandboxed" the engine runs `dotnet restore` once
 * per head in the OS sandbox with only NUGET_HOSTS reachable, writing new
 * packages into the run's own packages folder (nugetRunPackagesDir; the
 * real cache is the read-only fallback), then runs the gate again offline
 * on that folder; "park" (the default) parks with the reason.
 */
import { join } from 'node:path';
import { dotnetPositionals, MSBUILD_SUBCOMMANDS } from '../../copilot-run/dotnet-sandbox.js';
/**
 * The NuGet error codes that say a restore could not get a package, never
 * that the code is wrong: NU1100-NU1103 (no package or version resolved:
 * NU1100 unable to resolve, NU1101 no such id, NU1102 no such version,
 * NU1103 only prereleases) and the NU1300 series (a source failed: NU1301
 * cannot load the service index or reach the host, NU1302 an insecure http
 * source, NU1303 and later source errors). Only as `error NUxxxx`: a warning
 * (NU1900, audit without the feed) is not a failure.
 */
export const NUGET_RESTORE_ERROR = /\berror (NU(?:110[0-3]|13\d\d))\b/g;
/**
 * nuget.org's own feed host or source name, or the machine-wide local
 * source a Visual Studio install adds (it holds no credentials and NuGet
 * lists it next to nuget.org: "Found 1 version(s) in Microsoft Visual
 * Studio Offline Packages").
 */
const isNugetOrg = (s) => {
    const t = s.trim().replace(/[.'"]+$/, '');
    if (/^(?:nuget\.org|Microsoft Visual Studio Offline Packages)$/i.test(t))
        return true;
    const host = /^https?:\/\/([^/:\s'"]+)/i.exec(t)?.[1];
    return !!host && /(?:^|\.)nuget\.org$/i.test(host);
};
/**
 * The NuGet restore failure in a dotnet command's output, or null when the
 * output has no NuGet restore error (a compile or test failure, a pass).
 * Private feed signatures: "for source <not nuget.org>", "The local source
 * '<path>'", "in source(s): <a name other than nuget.org>", and a feed's
 * HTTP 401/403 ("Response status code does not indicate success: 401").
 * The sandbox proxy's own refusal ("The proxy tunnel request to proxy ...
 * failed with status code '403'") is not one: that is nuget.org blocked
 * offline.
 */
export function classifyNugetFailure(output) {
    if (!output)
        return null;
    const codes = [...new Set([...output.matchAll(NUGET_RESTORE_ERROR)].map((m) => m[1]))].sort();
    if (codes.length === 0)
        return null;
    const sources = new Set();
    for (const m of output.matchAll(/\bfor source '?(https?:\/\/[^\s'"\]]+)/gi))
        if (!isNugetOrg(m[1]))
            sources.add(m[1].replace(/[.'"]+$/, ''));
    for (const m of output.matchAll(/\bThe local source '([^'\r\n]+)'/gi))
        sources.add(m[1]);
    for (const m of output.matchAll(/\bin source\(s\): ([^\r\n\[]+)/gi)) {
        for (const name of m[1].split(','))
            if (name.trim() && !isNugetOrg(name))
                sources.add(name.trim().replace(/[.'"]+$/, ''));
    }
    const auth = /Response status code does not indicate success: 40[13]\b/i.test(output);
    return { kind: sources.size > 0 || auth ? 'private-feed' : 'restore', codes, sources: [...sources].sort() };
}
/**
 * The `dotnet restore` arguments for a dotnet gate's arguments (after the
 * executable): the same projects or solutions (the gate's positionals and
 * its `--project` / `--solution` values), its
 * runtime (`-r`, `--runtime`: a RID-specific restore) and its MSBuild
 * properties (`-p:`, `--property:`, `/p:`). Null when the gate runs no
 * MSBuild (`dotnet test <file>.dll`, a subcommand that does not restore).
 * The sandbox runner appends `-m:1`.
 */
export function dotnetRestoreArgs(gateArgs) {
    const sub = gateArgs[0]?.toLowerCase();
    if (!sub || !MSBUILD_SUBCOMMANDS.includes(sub) || sub === 'clean')
        return null;
    const rest = gateArgs.slice(1);
    const end = rest.indexOf('--');
    const args = end < 0 ? rest : rest.slice(0, end);
    const targets = dotnetPositionals(sub, args);
    if (sub === 'test' && targets.some((a) => /\.(?:dll|exe)$/i.test(a)))
        return null;
    const extra = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if ((a === '--project' || a === '--solution') && i + 1 < args.length)
            targets.push(args[++i]);
        else if (/^--(?:project|solution)[=:]/.test(a))
            targets.push(a.replace(/^--(?:project|solution)[=:]/, ''));
        else if ((a === '-r' || a === '--runtime') && i + 1 < args.length)
            extra.push(a, args[++i]);
        else if (/^(?:-r|--runtime)[=:]/.test(a) || /^(?:-p|--property|\/p|\/property):/i.test(a))
            extra.push(a);
    }
    return ['restore', ...targets, ...extra];
}
/** The run's own NuGet packages folder: `<gate job root>/nuget/<run slug>`, outside every checkout and never your real cache. */
export const nugetRunPackagesDir = (gateJobRoot, slug) => join(gateJobRoot, 'nuget', slug);
/** The setting and its two values, as the parks name them. */
export const GATE_INSTALL_SANDBOXED_HINT = 'set factory.run.gateInstall "sandboxed" in your user config (the engine then runs dotnet restore in the OS sandbox with only api.nuget.org reachable, after the gate definition check)';
/** The private-feed park's reason prefix. */
export const NUGET_PRIVATE_FEED_UNSUPPORTED = 'private or local NuGet feeds are not supported in the sandbox yet';
//# sourceMappingURL=nuget-restore.js.map