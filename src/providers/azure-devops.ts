import { execFileSync } from 'node:child_process';
import type { GitProvider, PRInfo, IssueInfo, WorkItem } from './types.js';

export type AdoErrorType = 'auth' | 'not-found' | 'timeout' | 'unknown';

export class AdoError extends Error {
  readonly type: AdoErrorType;
  constructor(message: string, type: AdoErrorType) {
    super(message);
    this.name = 'AdoError';
    this.type = type;
  }
}

function classifyError(err: unknown): AdoError {
  const msg = err instanceof Error ? err.message : String(err);
  const stderr = (err as any)?.stderr ? String((err as any).stderr) : msg;
  if (stderr.includes('az login') || stderr.includes('AADSTS') || stderr.includes('Please run') || stderr.includes('TF400813')) {
    return new AdoError(stderr, 'auth');
  }
  if (stderr.includes('TF401232') || stderr.includes('does not exist') || stderr.includes('404') || stderr.includes('ResourceNotFound')) {
    return new AdoError(stderr, 'not-found');
  }
  if (stderr.includes('timed out') || stderr.includes('ETIMEDOUT') || (err as any)?.killed) {
    return new AdoError(stderr, 'timeout');
  }
  return new AdoError(stderr, 'unknown');
}

function stripRefPrefix(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

export class AzureDevOpsProvider implements GitProvider {
  readonly name = 'azure-devops' as const;
  readonly displayName = 'Azure DevOps';
  readonly prTerminology = 'PR' as const;
  readonly prRefspec = null;

  detectFromRemote(url: string): boolean {
    return (
      url.includes('dev.azure.com') ||
      url.includes('ssh.dev.azure.com') ||
      url.includes('visualstudio.com')
    );
  }

  viewPR(number: number): PRInfo | null {
    if (!Number.isInteger(number) || number < 1) return null;
    try {
      const raw = execFileSync('az', ['repos', 'pr', 'show', '--id', String(number), '--output', 'json'], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw);
      const createdBy = data.createdBy as Record<string, unknown> | undefined;
      return {
        title: data.title as string,
        headBranch: data.sourceRefName ? stripRefPrefix(data.sourceRefName as string) : undefined,
        baseBranch: data.targetRefName ? stripRefPrefix(data.targetRefName as string) : undefined,
        url: data.url as string | undefined,
        body: data.description as string | undefined,
        author: createdBy?.displayName as string | undefined,
      };
    } catch (err) {
      throw classifyError(err);
    }
  }

  viewIssue(number: number): IssueInfo | null {
    if (!Number.isInteger(number) || number < 1) return null;
    try {
      const raw = execFileSync('az', ['boards', 'work-item', 'show', '--id', String(number), '--output', 'json'], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw);
      const fields = data.fields as Record<string, unknown> | undefined;
      return {
        title: (fields?.['System.Title'] as string) ?? '',
        body: fields?.['System.Description'] as string | undefined,
        url: data.url as string | undefined,
      };
    } catch (err) {
      throw classifyError(err);
    }
  }

  checkAuth(): boolean {
    try {
      execFileSync('az', ['account', 'show'], {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  getRequiredCLI(): string | null {
    return 'az';
  }

  escapeWiql(value: string): string {
    return value.replace(/'/g, "''");
  }

  listWorkItems(options: { state?: string; tags?: string[]; project?: string; org?: string; top?: number; skip?: number }): WorkItem[] {
    const conditions: string[] = [];
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
    if (options.org) args.push('--org', options.org);
    try {
      const raw = execFileSync('az', args, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw) as Array<{ id: number; fields: Record<string, unknown> }>;
      const paginated = data.slice(options.skip ?? 0, options.top ? (options.skip ?? 0) + options.top : undefined);
      return paginated.map((item) => this.normalizeWorkItem(item));
    } catch (err) {
      throw classifyError(err);
    }
  }

  createWorkItem(options: {
    title: string;
    type?: string;
    description?: string;
    tags?: string[];
    assignedTo?: string;
    areaPath?: string;
    iterationPath?: string;
    org?: string;
    project?: string;
  }): WorkItem {
    const args = [
      'boards', 'work-item', 'create',
      '--title', options.title,
      '--type', options.type ?? 'Task',
      '--output', 'json',
    ];
    if (options.org) args.push('--org', options.org);
    if (options.project) args.push('--project', options.project);
    const fields: string[] = [];
    if (options.description) fields.push(`System.Description=${options.description}`);
    if (options.assignedTo) fields.push(`System.AssignedTo=${options.assignedTo}`);
    if (options.tags && options.tags.length > 0) fields.push(`System.Tags=${options.tags.join('; ')}`);
    if (options.areaPath) fields.push(`System.AreaPath=${options.areaPath}`);
    if (options.iterationPath) fields.push(`System.IterationPath=${options.iterationPath}`);
    if (fields.length > 0) args.push('--fields', ...fields);
    const raw = execFileSync('az', args, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(raw) as { id: number; fields: Record<string, unknown> };
    return this.normalizeWorkItem(data);
  }

  addTag(workItemId: number, tag: string): void {
    const current = this.fetchWorkItemTags(workItemId);
    const updated = [...current, tag].join('; ');
    execFileSync('az', ['boards', 'work-item', 'update', '--id', String(workItemId), '--fields', `System.Tags=${updated}`, '--output', 'json'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  removeTag(workItemId: number, tag: string): void {
    const current = this.fetchWorkItemTags(workItemId);
    const updated = current.filter((t) => t !== tag).join('; ');
    execFileSync('az', ['boards', 'work-item', 'update', '--id', String(workItemId), '--fields', `System.Tags=${updated}`, '--output', 'json'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  addComment(workItemId: number, comment: string): void {
    execFileSync('az', ['boards', 'work-item', 'update', '--id', String(workItemId), '--discussion', comment, '--output', 'json'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  listPullRequests(options?: { status?: string; org?: string; project?: string }): PRInfo[] {
    const status = options?.status ?? 'active';
    const args = ['repos', 'pr', 'list', '--status', status, '--output', 'json'];
    if (options?.org) args.push('--org', options.org);
    if (options?.project) args.push('--project', options.project);
    try {
      const raw = execFileSync('az', args, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw) as Array<Record<string, unknown>>;
      return data.map((item) => {
        const createdBy = item['createdBy'] as Record<string, unknown> | undefined;
        return {
          title: item['title'] as string,
          headBranch: item['sourceRefName'] ? stripRefPrefix(item['sourceRefName'] as string) : undefined,
          baseBranch: item['targetRefName'] ? stripRefPrefix(item['targetRefName'] as string) : undefined,
          url: item['url'] as string | undefined,
          body: item['description'] as string | undefined,
          author: createdBy?.['displayName'] as string | undefined,
        };
      });
    } catch (err) {
      throw classifyError(err);
    }
  }

  createPullRequest(options: {
    title: string;
    sourceBranch: string;
    targetBranch: string;
    description?: string;
    org?: string;
    project?: string;
  }): PRInfo {
    const args = [
      'repos', 'pr', 'create',
      '--title', options.title,
      '--source-branch', options.sourceBranch,
      '--target-branch', options.targetBranch,
      '--output', 'json',
    ];
    if (options.description) args.push('--description', options.description);
    if (options.org) args.push('--org', options.org);
    if (options.project) args.push('--project', options.project);
    const raw = execFileSync('az', args, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(raw) as Record<string, unknown>;
    const createdBy = data['createdBy'] as Record<string, unknown> | undefined;
    return {
      title: data['title'] as string,
      headBranch: data['sourceRefName'] ? stripRefPrefix(data['sourceRefName'] as string) : undefined,
      baseBranch: data['targetRefName'] ? stripRefPrefix(data['targetRefName'] as string) : undefined,
      url: data['url'] as string | undefined,
      body: data['description'] as string | undefined,
      author: createdBy?.['displayName'] as string | undefined,
    };
  }

  mergePullRequest(id: number, org?: string): void {
    const args = ['repos', 'pr', 'update', '--id', String(id), '--status', 'completed', '--output', 'json'];
    if (org) args.push('--org', org);
    execFileSync('az', args, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  updateWorkItemState(workItemId: number, state: string, org?: string): void {
    const args = ['boards', 'work-item', 'update', '--id', String(workItemId), '--fields', `System.State=${state}`, '--output', 'json'];
    if (org) args.push('--org', org);
    execFileSync('az', args, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  linkWorkItemToPR(workItemId: number, prId: number, org?: string, project?: string): void {
    const args = [
      'boards', 'work-item', 'relation', 'add',
      '--id', String(workItemId),
      '--relation-type', 'ArtifactLink',
      '--target-url', `vstfs:///Git/PullRequestId/${prId}`,
      '--output', 'json',
    ];
    if (org) args.push('--org', org);
    if (project) args.push('--project', project);
    execFileSync('az', args, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  listPRsForReviewer(reviewerEmail: string, options?: { status?: string; org?: string; project?: string; repository?: string }): PRInfo[] {
    const status = options?.status ?? 'active';
    const args = ['repos', 'pr', 'list', '--reviewer', reviewerEmail, '--status', status, '--output', 'json'];
    if (options?.org) args.push('--org', options.org);
    if (options?.project) args.push('--project', options.project);
    if (options?.repository) args.push('--repository', options.repository);
    try {
      const raw = execFileSync('az', args, {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(raw) as Array<Record<string, unknown>>;
      return data.map((item) => {
        const createdBy = item['createdBy'] as Record<string, unknown> | undefined;
        return {
          title: item['title'] as string,
          headBranch: item['sourceRefName'] ? stripRefPrefix(item['sourceRefName'] as string) : undefined,
          baseBranch: item['targetRefName'] ? stripRefPrefix(item['targetRefName'] as string) : undefined,
          url: item['url'] as string | undefined,
          body: item['description'] as string | undefined,
          author: createdBy?.['displayName'] as string | undefined,
        };
      });
    } catch (err) {
      throw classifyError(err);
    }
  }

  getPRDiff(prId: number, org?: string): string {
    if (!Number.isInteger(prId) || prId < 1) return '';
    const args = ['repos', 'pr', 'diff', '--id', String(prId), '--output', 'json'];
    if (org) args.push('--org', org);
    try {
      const raw = execFileSync('az', args, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return raw;
    } catch (err) {
      throw classifyError(err);
    }
  }

  private fetchWorkItemTags(workItemId: number): string[] {
    const raw = execFileSync('az', ['boards', 'work-item', 'show', '--id', String(workItemId), '--output', 'json'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(raw) as { fields?: Record<string, unknown> };
    const tagsRaw = data.fields?.['System.Tags'] as string | undefined;
    if (!tagsRaw) return [];
    return tagsRaw.split(';').map((t) => t.trim()).filter(Boolean);
  }

  private normalizeWorkItem(item: { id: number; fields: Record<string, unknown> }): WorkItem {
    const fields = item.fields;
    const tagsRaw = fields['System.Tags'] as string | undefined;
    const tags = tagsRaw ? tagsRaw.split(';').map((t) => t.trim()).filter(Boolean) : [];
    const assignedTo = fields['System.AssignedTo'] as Record<string, unknown> | string | undefined;
    return {
      id: item.id,
      title: (fields['System.Title'] as string) ?? '',
      state: (fields['System.State'] as string) ?? '',
      tags,
      assignedTo: typeof assignedTo === 'object' && assignedTo !== null
        ? (assignedTo['displayName'] as string | undefined)
        : (assignedTo as string | undefined),
      url: fields['System.TeamFoundationId'] as string | undefined,
    };
  }
}
