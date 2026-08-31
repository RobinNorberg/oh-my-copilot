/**
 * Permission auto-approval configuration for oh-my-copilot.
 * Three-tier system: Tier 1 (read-only auto-approve), Tier 2 (write auto-approve), Tier 3 (always prompt).
 */
/** Tools that should NEVER be auto-approved (Tier 3) */
export const DANGEROUS_TOOLS = [
    'mcp__t__shared_memory_delete',
    'mcp__t__shared_memory_cleanup',
    'mcp__t__kill_job',
];
/** Generate the full Tier 1 + Tier 2 permission allowlist */
export function generatePermissionAllowList() {
    return [
        // Tier 1: Read-only tools (always auto-approve)
        'mcp__t__lsp_hover',
        'mcp__t__lsp_goto_definition',
        'mcp__t__lsp_find_references',
        'mcp__t__lsp_document_symbols',
        'mcp__t__lsp_workspace_symbols',
        'mcp__t__lsp_diagnostics',
        'mcp__t__lsp_diagnostics_directory',
        'mcp__t__lsp_servers',
        'mcp__t__lsp_prepare_rename',
        'mcp__t__ast_grep_search',
        'mcp__t__notepad_read',
        'mcp__t__notepad_stats',
        'mcp__t__project_memory_read',
        'mcp__t__shared_memory_read',
        'mcp__t__shared_memory_list',
        'mcp__t__load_omc_skills_local',
        'mcp__t__load_omc_skills_global',
        'mcp__t__deepinit_manifest',
        'mcp__t__check_job_status',
        'mcp__t__list_jobs',
        'mcp__t__state_read',
        'mcp__t__state_get_status',
        'mcp__t__state_list_active',
        'mcp__t__trace_summary',
        'mcp__t__trace_timeline',
        // Tier 2: Write tools (auto-approve within project)
        'mcp__t__lsp_rename',
        'mcp__t__lsp_code_actions',
        'mcp__t__lsp_code_action_resolve',
        'mcp__t__ast_grep_replace',
        'mcp__t__notepad_write_priority',
        'mcp__t__notepad_write_working',
        'mcp__t__notepad_write_manual',
        'mcp__t__notepad_prune',
        'mcp__t__project_memory_write',
        'mcp__t__project_memory_add_note',
        'mcp__t__project_memory_add_directive',
        'mcp__t__state_write',
        'mcp__t__state_clear',
        'mcp__t__shared_memory_write',
        'mcp__t__python_repl',
        'mcp__t__wait_for_job',
    ];
}
//# sourceMappingURL=permissions.js.map