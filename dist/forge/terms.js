/**
 * The words user-facing output uses for a forge and its items, so the local
 * (offline) forge never prints GitHub or Azure DevOps terms (dogfood F23/F35).
 * Every call site reads them from here instead of spelling its own.
 */
const TERMS = {
    github: { name: 'GitHub', item: 'issue', acceptance: 'issue Acceptance criteria', body: 'issue body' },
    'azure-devops': { name: 'Azure DevOps', item: 'work item', acceptance: 'work item Acceptance Criteria', body: 'work item description' },
    local: { name: 'the local forge', item: 'backlog item', acceptance: 'backlog item Acceptance section', body: 'backlog item body' },
};
export function forgeTerms(kind) {
    return TERMS[kind];
}
//# sourceMappingURL=terms.js.map