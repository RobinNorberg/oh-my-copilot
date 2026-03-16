import { execFileSync } from 'node:child_process';
export class AdoError extends Error {
    type;
    constructor(message, type) {
        super(message);
        this.name = 'AdoError';
        this.type = type;
    }
}
function classifyError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = err?.stderr ? String(err.stderr) : msg;
    if (stderr.includes('az login') || stderr.includes('AADSTS') || stderr.includes('Please run') || stderr.includes('TF400813')) {
        return new AdoError(stderr, 'auth');
    }
    if (stderr.includes('TF401232') || stderr.includes('does not exist') || stderr.includes('404') || stderr.includes('ResourceNotFound')) {
        return new AdoError(stderr, 'not-found');
    }
    if (stderr.includes('timed out') || stderr.includes('ETIMEDOUT') || err?.killed) {
        return new AdoError(stderr, 'timeout');
    }
    return new AdoError(stderr, 'unknown');
}
function stripRefPrefix(ref) {
    return ref.replace(/^refs\/heads\//, '');
}
export class AzureDevOpsProvider {
    name = 'azure-devops';
    displayName = 'Azure DevOps';
    prTerminology = 'PR';
    prRefspec = null;
    detectFromRemote(url) {
        return (url.includes('dev.azure.com') ||
            url.includes('ssh.dev.azure.com') ||
            url.includes('visualstudio.com'));
    }
    viewPR(number) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        try {
            const raw = execFileSync('az', ['repos', 'pr', 'show', '--id', String(number), '--output', 'json'], {
                encoding: 'utf-8',
                timeout: 15000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            const createdBy = data.createdBy;
            return {
                title: data.title,
                headBranch: data.sourceRefName ? stripRefPrefix(data.sourceRefName) : undefined,
                baseBranch: data.targetRefName ? stripRefPrefix(data.targetRefName) : undefined,
                url: data.url,
                body: data.description,
                author: createdBy?.displayName,
            };
        }
        catch (err) {
            throw classifyError(err);
        }
    }
    viewIssue(number) {
        if (!Number.isInteger(number) || number < 1)
            return null;
        try {
            const raw = execFileSync('az', ['boards', 'work-item', 'show', '--id', String(number), '--output', 'json'], {
                encoding: 'utf-8',
                timeout: 15000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            const fields = data.fields;
            return {
                title: fields?.['System.Title'] ?? '',
                body: fields?.['System.Description'],
                url: data.url,
            };
        }
        catch (err) {
            throw classifyError(err);
        }
    }
    checkAuth() {
        try {
            execFileSync('az', ['account', 'show'], {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return true;
        }
        catch {
            return false;
        }
    }
    getRequiredCLI() {
        return 'az';
    }
    escapeWiql(value) {
        return value.replace(/'/g, "''");
    }
    listWorkItems(options) {
        const conditions = [];
        if (options.state) {
            conditions.push(`[System.State] = '${this.escapeWiql(options.state)}'`);
        }
        if (options.tags && options.tags.length > 0) {
            for (const tag of options.tags) {
                conditions.push(`[System.Tags] Contains '${this.escapeWiql(tag)}'`);
            }
        }
        if (options.project) {
            conditions.push(`[System.TeamProject] = '${this.escapeWiql(options.project)}'`);
        }
        const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
        const wiql = `SELECT [System.Id],[System.Title],[System.State],[System.Tags],[System.AssignedTo] FROM WorkItems${where} ORDER BY [System.CreatedDate] DESC`;
        const args = ['boards', 'query', '--wiql', wiql, '--output', 'json'];
        if (options.org)
            args.push('--org', options.org);
        try {
            const raw = execFileSync('az', args, {
                encoding: 'utf-8',
                timeout: 15000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            const paginated = data.slice(options.skip ?? 0, options.top ? (options.skip ?? 0) + options.top : undefined);
            return paginated.map((item) => this.normalizeWorkItem(item));
        }
        catch (err) {
            throw classifyError(err);
        }
    }
    createWorkItem(options) {
        const args = [
            'boards', 'work-item', 'create',
            '--title', options.title,
            '--type', options.type ?? 'Task',
            '--output', 'json',
        ];
        if (options.org)
            args.push('--org', options.org);
        if (options.project)
            args.push('--project', options.project);
        const fields = [];
        if (options.description)
            fields.push(`System.Description=${options.description}`);
        if (options.assignedTo)
            fields.push(`System.AssignedTo=${options.assignedTo}`);
        if (options.tags && options.tags.length > 0)
            fields.push(`System.Tags=${options.tags.join('; ')}`);
        if (options.areaPath)
            fields.push(`System.AreaPath=${options.areaPath}`);
        if (options.iterationPath)
            fields.push(`System.IterationPath=${options.iterationPath}`);
        if (fields.length > 0)
            args.push('--fields', ...fields);
        const raw = execFileSync('az', args, {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const data = JSON.parse(raw);
        return this.normalizeWorkItem(data);
    }
    addTag(workItemId, tag) {
        const current = this.fetchWorkItemTags(workItemId);
        const updated = [...current, tag].join('; ');
        execFileSync('az', ['boards', 'work-item', 'update', '--id', String(workItemId), '--fields', `System.Tags=${updated}`, '--output', 'json'], {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    removeTag(workItemId, tag) {
        const current = this.fetchWorkItemTags(workItemId);
        const updated = current.filter((t) => t !== tag).join('; ');
        execFileSync('az', ['boards', 'work-item', 'update', '--id', String(workItemId), '--fields', `System.Tags=${updated}`, '--output', 'json'], {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    addComment(workItemId, comment) {
        execFileSync('az', ['boards', 'work-item', 'update', '--id', String(workItemId), '--discussion', comment, '--output', 'json'], {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    listPullRequests(options) {
        const status = options?.status ?? 'active';
        const args = ['repos', 'pr', 'list', '--status', status, '--output', 'json'];
        if (options?.org)
            args.push('--org', options.org);
        if (options?.project)
            args.push('--project', options.project);
        try {
            const raw = execFileSync('az', args, {
                encoding: 'utf-8',
                timeout: 15000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            return data.map((item) => {
                const createdBy = item['createdBy'];
                return {
                    title: item['title'],
                    headBranch: item['sourceRefName'] ? stripRefPrefix(item['sourceRefName']) : undefined,
                    baseBranch: item['targetRefName'] ? stripRefPrefix(item['targetRefName']) : undefined,
                    url: item['url'],
                    body: item['description'],
                    author: createdBy?.['displayName'],
                };
            });
        }
        catch (err) {
            throw classifyError(err);
        }
    }
    createPullRequest(options) {
        const args = [
            'repos', 'pr', 'create',
            '--title', options.title,
            '--source-branch', options.sourceBranch,
            '--target-branch', options.targetBranch,
            '--output', 'json',
        ];
        if (options.description)
            args.push('--description', options.description);
        if (options.org)
            args.push('--org', options.org);
        if (options.project)
            args.push('--project', options.project);
        const raw = execFileSync('az', args, {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const data = JSON.parse(raw);
        const createdBy = data['createdBy'];
        return {
            title: data['title'],
            headBranch: data['sourceRefName'] ? stripRefPrefix(data['sourceRefName']) : undefined,
            baseBranch: data['targetRefName'] ? stripRefPrefix(data['targetRefName']) : undefined,
            url: data['url'],
            body: data['description'],
            author: createdBy?.['displayName'],
        };
    }
    mergePullRequest(id, org) {
        const args = ['repos', 'pr', 'update', '--id', String(id), '--status', 'completed', '--output', 'json'];
        if (org)
            args.push('--org', org);
        execFileSync('az', args, {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    updateWorkItemState(workItemId, state, org) {
        const args = ['boards', 'work-item', 'update', '--id', String(workItemId), '--fields', `System.State=${state}`, '--output', 'json'];
        if (org)
            args.push('--org', org);
        execFileSync('az', args, {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    linkWorkItemToPR(workItemId, prId, org, project) {
        const args = [
            'boards', 'work-item', 'relation', 'add',
            '--id', String(workItemId),
            '--relation-type', 'ArtifactLink',
            '--target-url', `vstfs:///Git/PullRequestId/${prId}`,
            '--output', 'json',
        ];
        if (org)
            args.push('--org', org);
        if (project)
            args.push('--project', project);
        execFileSync('az', args, {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    listPRsForReviewer(reviewerEmail, options) {
        const status = options?.status ?? 'active';
        const args = ['repos', 'pr', 'list', '--reviewer', reviewerEmail, '--status', status, '--output', 'json'];
        if (options?.org)
            args.push('--org', options.org);
        if (options?.project)
            args.push('--project', options.project);
        if (options?.repository)
            args.push('--repository', options.repository);
        try {
            const raw = execFileSync('az', args, {
                encoding: 'utf-8',
                timeout: 15000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const data = JSON.parse(raw);
            return data.map((item) => {
                const createdBy = item['createdBy'];
                return {
                    title: item['title'],
                    headBranch: item['sourceRefName'] ? stripRefPrefix(item['sourceRefName']) : undefined,
                    baseBranch: item['targetRefName'] ? stripRefPrefix(item['targetRefName']) : undefined,
                    url: item['url'],
                    body: item['description'],
                    author: createdBy?.['displayName'],
                };
            });
        }
        catch (err) {
            throw classifyError(err);
        }
    }
    getPRDiff(prId, org) {
        if (!Number.isInteger(prId) || prId < 1)
            return '';
        const args = ['repos', 'pr', 'diff', '--id', String(prId), '--output', 'json'];
        if (org)
            args.push('--org', org);
        try {
            const raw = execFileSync('az', args, {
                encoding: 'utf-8',
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return raw;
        }
        catch (err) {
            throw classifyError(err);
        }
    }
    fetchWorkItemTags(workItemId) {
        const raw = execFileSync('az', ['boards', 'work-item', 'show', '--id', String(workItemId), '--output', 'json'], {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const data = JSON.parse(raw);
        const tagsRaw = data.fields?.['System.Tags'];
        if (!tagsRaw)
            return [];
        return tagsRaw.split(';').map((t) => t.trim()).filter(Boolean);
    }
    normalizeWorkItem(item) {
        const fields = item.fields;
        const tagsRaw = fields['System.Tags'];
        const tags = tagsRaw ? tagsRaw.split(';').map((t) => t.trim()).filter(Boolean) : [];
        const assignedTo = fields['System.AssignedTo'];
        return {
            id: item.id,
            title: fields['System.Title'] ?? '',
            state: fields['System.State'] ?? '',
            tags,
            assignedTo: typeof assignedTo === 'object' && assignedTo !== null
                ? assignedTo['displayName']
                : assignedTo,
            url: fields['System.TeamFoundationId'],
        };
    }
}
//# sourceMappingURL=azure-devops.js.map