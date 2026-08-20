import { describe, expect, it } from 'vitest';
import { formatCommandResult, PRESENTED_COMMAND_IDS } from '../presentation.js';
import { commandError, commandSuccess } from '../results.js';

describe('command presentation', () => {
  it('renders a plan as a compact review without changing its envelope', () => {
    const envelope = commandSuccess({
      planId: 'plan-1234567890-abcdef',
      environment: 'production',
      specRevision: 42,
      verified: true,
      pendingActionCount: 2,
      noopActionCount: 3,
      actions: [
        {
          id: 'service:web',
          type: 'create',
          resource: { kind: 'service', name: 'web', provider: 'railway' },
          reason: 'Service is missing.',
        },
        {
          id: 'domain:example.com',
          type: 'update',
          resource: { kind: 'domain', name: 'example.com', provider: 'cloudflare' },
          reason: 'DNS differs.',
          requiresConfirm: true,
        },
      ],
      blocked: [],
      unmanaged: [],
    }, {
      hint: 'Apply this exact plan.',
      next: ['hv_apply'],
    });

    const output = formatCommandResult('hv_plan', envelope);

    expect(output).toContain('📋  HYPERVIBE · PLAN READY');
    expect(output).toContain('production · plan plan-123…90-abcdef');
    expect(output).toContain('2 changes · 3 already in sync · 1 confirmation');
    expect(output).toContain('➕ service:web');
    expect(output).toContain('create · railway');
    expect(output).toContain('🔧 domain:example.com');
    expect(output).toContain('confirmation required');
    expect(output).toContain('➡️  NEXT\n`hv_apply`');
    expect(output).not.toMatch(/\u001b\[/);
    expect(envelope.data).toMatchObject({ planId: 'plan-1234567890-abcdef' });
  });

  it('distinguishes in-sync status from provider verification', () => {
    const output = formatCommandResult('hv_status', commandSuccess({
      environment: 'staging',
      specRevision: 7,
      verified: true,
      inSync: true,
      drift: [],
      unmanaged: [],
      blocked: [],
      services: [{ name: 'web', status: 'running', url: 'https://staging.example.com' }],
      runtimeHealth: { status: 'unverified' },
    }));

    expect(output).toContain('✅  HYPERVIBE · IN SYNC');
    expect(output).toContain('staging · spec r7');
    expect(output).toContain('0 changes · 1 service · provider verified');
    expect(output).toMatch(/RESULT\s+SERVICE\s+STATUS\s+URL/);
    expect(output).toMatch(/🟢\s+web\s+running\s+https:\/\/staging\.example\.com/);
    expect(output).toContain('Runtime Health:');
  });

  it('does not label incomplete observation as drift when no drift was proven', () => {
    const output = formatCommandResult('hv_status', commandSuccess({
      environment: 'production',
      verified: false,
      inSync: false,
      drift: [],
      unmanaged: [],
      blocked: [],
    }));

    expect(output).toContain('⚠️  HYPERVIBE · STATUS UNKNOWN');
    expect(output).toContain('verification incomplete');
    expect(output).not.toContain('DRIFT DETECTED');
  });

  it('labels deferred runtime configuration as restart required instead of in sync', () => {
    const output = formatCommandResult('hv_status', commandSuccess({
      environment: 'production',
      verified: true,
      inSync: false,
      restartRequired: true,
      runtimeConfiguration: {
        status: 'restart_required',
        services: [{
          service: 'worker',
          provider: 'railway',
          requiredSince: '2026-08-20T20:25:00.000Z',
          reason: 'The service is still running the deployment that was active before the configuration change.',
          actionIds: ['secret:ANTHROPIC_API_KEY'],
        }],
      },
      drift: [],
      unmanaged: [],
      blocked: [],
      services: [{ name: 'worker', status: 'running' }],
    }));

    expect(output).toContain('♻️  HYPERVIBE · RESTART REQUIRED');
    expect(output).toContain('1 service awaiting rollout');
    expect(output).toContain('restart_required');
    expect(output).not.toContain('HYPERVIBE · IN SYNC');
  });

  it('does not call a plan ready when a scoped connection is required before apply', () => {
    const output = formatCommandResult('hv_plan', commandSuccess({
      environment: 'production',
      planId: 'plan-2',
      pendingActionCount: 1,
      noopActionCount: 0,
      actions: [{
        id: 'ci:deploy',
        type: 'update',
        resource: { kind: 'ci', name: 'deploy', provider: 'github-actions' },
      }],
      blocked: [],
      actionScopedBlocked: [{
        provider: 'github',
        reason: 'Package-read credentials are missing.',
      }],
    }));

    expect(output).toContain('🚧  HYPERVIBE · PLAN BLOCKED');
    expect(output).not.toContain('PLAN READY');
  });

  it('makes partial apply progress impossible to mistake for success', () => {
    const output = formatCommandResult('hv_apply', commandSuccess({
      applied: false,
      applyRunId: 'run-1234567890-abcdef',
      environment: 'production',
      receipts: [
        { actionId: 'service:web', status: 'succeeded' },
        { actionId: 'domain:example.com', status: 'pending' },
      ],
    }));

    expect(output).toContain('❌  HYPERVIBE · APPLY STOPPED');
    expect(output).toContain('1 succeeded action · 1 pending action');
    expect(output).toContain('✅ service:web');
    expect(output).not.toContain('service:web · succeeded');
    expect(output).toContain('⏳ domain:example.com · pending');
    expect(output).toContain('🛑  AGENT INSTRUCTION');
  });

  it('renders HTTP health with status and latency', () => {
    const output = formatCommandResult('hv_health', commandSuccess({
      service: 'web',
      baseUrl: 'https://example.com',
      check: {
        name: 'health',
        url: 'https://example.com/health',
        ok: true,
        status: 200,
        latencyMs: 84,
      },
      deploymentHealth: { state: 'healthy', environments: [], failures: [] },
    }));

    expect(output).toContain('✅  HYPERVIBE · HEALTHY');
    expect(output).toContain('web · https://example.com');
    expect(output).toContain('HTTP 200 · 84 ms · deployments healthy');
  });

  it('gives every command a command-aware shared success presentation', () => {
    const output = formatCommandResult('hv_inspect', commandSuccess({
      provider: 'gitlab',
      resources: [{ id: '1', name: 'web', status: 'success', url: 'https://example.com/web' }],
    }));

    expect(output).toContain('✅  HYPERVIBE · INSPECT COMPLETE');
    expect(output).toContain('📦  RESULT');
    expect(output).toContain('gitlab');
    expect(output).toContain('Resources: 1');
    expect(output).toMatch(/RESULT\s+NAME\s+URL\s+ID/);
    expect(output).toMatch(/✅\s+web\s+https:\/\/example\.com\/web\s+1/);
    expect(output).not.toContain('success');
  });

  it('uses pending rather than success styling for acknowledged async work', () => {
    const output = formatCommandResult('hv_rollback', commandSuccess({
      environment: 'production',
      status: 'pending',
      pending: true,
      workflowRunId: '1234',
    }));

    expect(output).toContain('⏳  HYPERVIBE · ROLLBACK PENDING');
    expect(output).not.toContain('ROLLBACK COMPLETE');
  });

  it('renders runtime logs as readable timestamped lines', () => {
    const output = formatCommandResult('hv_logs', commandSuccess({
      source: 'service',
      provider: 'railway',
      environment: 'staging',
      service: 'web',
      deploymentStatus: 'success',
      count: 2,
      logs: [
        { timestamp: '2026-08-20T12:00:00Z', severity: 'info', message: 'Listening on :3000' },
        { timestamp: '2026-08-20T12:00:01Z', severity: 'error', message: 'Request failed\nretry exhausted' },
      ],
    }));

    expect(output).toContain('✅  HYPERVIBE · LOGS');
    expect(output).toContain('staging · web · railway');
    expect(output).toContain('2 log entries · deployment success');
    expect(output).toContain('• 2026-08-20T12:00:00Z · INFO · Listening on :3000');
    expect(output).toContain('❌ 2026-08-20T12:00:01Z · ERROR · Request failed');
    expect(output).toContain('  │ retry exhausted');
  });

  it('renders a bounded build-log tail and its truncation metadata', () => {
    const output = formatCommandResult('hv_logs', commandSuccess({
      source: 'build',
      provider: 'railway',
      service: 'web',
      deploymentId: 'deployment-123',
      buildLogs: 'test\ndeploy',
      lineCount: 20,
      returnedLines: 2,
      truncated: true,
    }));

    expect(output).toContain('✅  HYPERVIBE · LOGS');
    expect(output).toContain('deployment deployment-123 · 2 returned · 20 total · tail truncated');
    expect(output).toContain('🏗️  BUILD LOG');
    expect(output).toContain('│ test');
    expect(output).toContain('│ deploy');
  });

  it('renders CI job log text instead of reducing it to an object count', () => {
    const output = formatCommandResult('hv_ci_status', commandSuccess({
      repository: 'davejohnson/invoice-express',
      logs: [{
        jobId: '96485414159',
        name: 'critical journey',
        phase: 'failed',
        text: 'Run npm test\nError: expected 200',
        lineCount: 200,
        returnedLines: 2,
        truncated: true,
      }],
    }));

    expect(output).toContain('✅  HYPERVIBE · CI STATUS');
    expect(output).toContain('📜  LOGS');
    expect(output).toContain('❌ critical journey · job 96485414159');
    expect(output).not.toContain('critical journey · failed');
    expect(output).toContain('2 returned · 200 total · tail truncated');
    expect(output).toContain('  │ Run npm test');
    expect(output).toContain('  │ Error: expected 200');
    expect(output).not.toContain('Logs: 1');
  });

  it('renders repeated CI runs as a compact table', () => {
    const firstUrl = 'https://github.com/davejohnson/invoice-express/actions/runs/32403831183';
    const secondUrl = 'https://github.com/davejohnson/invoice-express/actions/runs/32403414765';
    const output = formatCommandResult('hv_ci_status', commandSuccess({
      repository: 'davejohnson/invoice-express',
      runs: [
        {
          name: 'staging critical journey',
          id: 32403831183,
          status: 'completed',
          conclusion: 'success',
          branch: 'main',
          createdAt: '2026-08-20T18:00:00Z',
          url: firstUrl,
        },
        {
          name: 'staging critical journey',
          id: 32403414765,
          status: 'completed',
          conclusion: 'failure',
          branch: 'main',
          createdAt: '2026-08-20T17:00:00Z',
          url: secondUrl,
        },
      ],
    }));

    expect(output).toContain('2 runs · staging critical journey');
    expect(output).toMatch(/2 runs · staging critical journey\n\nOUTCOME/);
    expect(output).toMatch(/OUTCOME\s+PHASE\s+BRANCH\s+CREATED\s+URL\s+RUN ID/);
    expect(output).toMatch(new RegExp(`✅ success\\s+completed\\s+main\\s+2026-08-20T18:00:00Z\\s+${firstUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+32403831183`));
    expect(output).toMatch(new RegExp(`❌ failure\\s+completed\\s+main\\s+2026-08-20T17:00:00Z\\s+${secondUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+32403414765`));
    expect(output).not.toContain('name: staging critical journey');
    expect(output).not.toContain('status: completed');
    expect(output).toContain('success');
    expect(output).toContain('failure');
  });

  it('renders provider-neutral CI run fields in the same table', () => {
    const output = formatCommandResult('hv_ci_status', commandSuccess({
      repository: { scope: 'group/project' },
      runs: [{
        id: 'pipeline-42',
        name: 'GitLab pipeline',
        phase: 'succeeded',
        nativeStatus: 'success',
        webUrl: 'https://gitlab.example.com/group/project/-/pipelines/42',
      }],
    }));

    expect(output).toContain('1 run · GitLab pipeline');
    expect(output).toMatch(/OUTCOME\s+URL\s+RUN ID/);
    expect(output).toMatch(/✅ succeeded\s+https:\/\/gitlab\.example\.com\/group\/project\/-\/pipelines\/42\s+pipeline-42/);
    expect(output).not.toMatch(/^OUTCOME\s+PHASE/m);
  });

  it('uses the same outcome-first ordering for CI jobs and artifacts', () => {
    const output = formatCommandResult('hv_ci_status', commandSuccess({
      repository: 'davejohnson/invoice-express',
      jobs: [{
        id: 'job-99',
        name: 'test',
        status: 'completed',
        conclusion: 'failure',
        startedAt: '2026-08-20T18:00:00Z',
        completedAt: '2026-08-20T18:02:00Z',
      }],
      artifacts: [{
        id: 'artifact-7',
        name: 'failure-evidence',
        expired: false,
        createdAt: '2026-08-20T18:02:00Z',
      }],
    }));

    expect(output).toMatch(/RESULT\s+NAME\s+STATUS\s+STARTED AT\s+COMPLETED AT\s+ID/);
    expect(output).toMatch(/❌\s+test\s+completed\s+2026-08-20T18:00:00Z\s+2026-08-20T18:02:00Z\s+job-99/);
    expect(output).toMatch(/RESULT\s+NAME\s+CREATED AT\s+ID/);
    expect(output).toMatch(/✅\s+failure-evidence\s+2026-08-20T18:02:00Z\s+artifact-7/);
    expect(output).not.toContain('failure     ');
    expect(output).not.toContain('Expired: false');
  });

  it('tables connection lists with result first and opaque details last', () => {
    const output = formatCommandResult('hv_connections', commandSuccess({
      connections: [
        { provider: 'github', scope: 'davejohnson/hypervibe', status: 'verified', lastVerifiedAt: '2026-08-20T18:00:00Z' },
        { provider: 'cloudflare', scope: 'example.com', status: 'failed', lastVerifiedAt: '2026-08-20T17:00:00Z' },
      ],
    }));

    expect(output).toContain('Connections: 2');
    expect(output).toMatch(/Connections: 2\n\nRESULT/);
    expect(output).toMatch(/RESULT\s+PROVIDER\s+SCOPE\s+LAST VERIFIED AT/);
    expect(output).toMatch(/✅\s+github\s+davejohnson\/hypervibe\s+2026-08-20T18:00:00Z/);
    expect(output).toMatch(/❌\s+cloudflare\s+example\.com\s+2026-08-20T17:00:00Z/);
    expect(output).not.toContain('verified');
    expect(output).not.toContain('failed');
  });

  it('preserves database query column order instead of reinterpreting row data', () => {
    const output = formatCommandResult('hv_db_query', commandSuccess({
      rowCount: 2,
      rows: [
        { id: 1, status: 'success', total: 42 },
        { id: 2, status: 'failure', total: 7 },
      ],
      fields: ['id', 'status', 'total'],
    }));

    expect(output).toMatch(/ID\s+STATUS\s+TOTAL/);
    expect(output).toMatch(/1\s+success\s+42/);
    expect(output).toMatch(/2\s+failure\s+7/);
    expect(output).not.toContain('RESULT  ID');
  });

  it('does not show a green success check when a requested CI section failed to load', () => {
    const output = formatCommandResult('hv_ci_status', commandSuccess({
      repository: 'davejohnson/invoice-express',
      logs: { error: 'GitHub returned 502' },
    }));

    expect(output).toContain('⚠️  HYPERVIBE · CI STATUS PARTIAL');
    expect(output).toContain('GitHub returned 502');
    expect(output).not.toContain('✅  HYPERVIBE');
  });

  it('covers the complete registered command surface centrally', () => {
    const ids = [...PRESENTED_COMMAND_IDS].sort();
    expect(ids).toEqual([
      'hv_apply',
      'hv_appstore_status',
      'hv_appstore_submit',
      'hv_ci_status',
      'hv_ci_trigger',
      'hv_connections',
      'hv_db_query',
      'hv_deploy',
      'hv_destroy',
      'hv_health',
      'hv_import',
      'hv_inspect',
      'hv_logs',
      'hv_plan',
      'hv_rollback',
      'hv_runs',
      'hv_secrets',
      'hv_spec',
      'hv_status',
    ]);
    ids.forEach((id) => {
      const output = formatCommandResult(id, commandSuccess({ id: 'sample' }));
      expect(output).toContain('HYPERVIBE ·');
      expect(output).not.toContain('HYPERVIBE · COMPLETE');
    });
  });

  it('renders environment coverage errors without clipping variable names or messages', () => {
    const keys = [
      'STAGING_CANARY_KEY',
      'STAGING_CANARY_SHOPIFY_CLIENT_ID',
      'STAGING_CANARY_SHOPIFY_CLIENT_SECRET',
      'STAGING_CANARY_SHOPIFY_DOMAIN',
    ];
    const envelope = commandError(
      'VALIDATION',
      'Environment-variable coverage is incomplete.',
      {
        details: keys.map((key) => ({
          reason: 'missing_environment',
          key,
          environment: 'production',
          declaredIn: ['staging'],
          requiredEnvironments: ['production', 'staging'],
          message: `${key} is required for matching services but has no desired-state declaration or explicit exception in production.`,
        })),
        hint: 'Declare each key or add an explicit environment exception.',
      }
    );

    const output = formatCommandResult('hv_spec', envelope);

    expect(output).toContain('❌  HYPERVIBE · SPEC REJECTED');
    expect(output).toContain('🔎  4 ISSUES');
    keys.forEach((key) => expect(output).toContain(`• ${key} → production`));
    expect(output).toContain('missing environment · declared in staging · required in production, staging');
    expect(output).not.toContain('prod...');
    expect(output).not.toContain('de...');
    expect(envelope.error?.details).toHaveLength(4);
  });
});
