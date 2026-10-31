import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { sourceBranchSchema } from '../cloud-source-branch.js';
import type { CloudInstallationAuthentication, CloudInstallationDriver } from '../../domain/ports/cloud-installation.port.js';
import type { CloudDeploymentCapability, CloudDeploymentConnectionV1, CloudDeploymentSessionV1, CloudDeploymentReleaseTargetsV1, CloudDeploymentSourceAuthorizationV1 } from '../../domain/ports/cloud-deployment.port.js';
import type { ProjectSpec } from '../../domain/spec/spec.schema.js';
import { CloudDeploymentAccessError, parseCloudDeploymentConnectionV1, parseCloudDeploymentSessionV1,
  parseCloudDeploymentSourceAuthorizationV1, cloudDeploymentEffectiveSourceV1, cloudDeploymentSourceAuthorityDigestV1 } from '../../domain/services/cloud-deployment-authentication.js';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import { parseCloudInstallationIntentV1 } from './cloud-installation.js';
import type { CloudInstallationIntent } from '../../domain/ports/cloud-installation.port.js';

/** Derives only the topology; the host supplies independently authorized exact source/scope. */
export function prepareCloudDeploymentIntentV1(spec: ProjectSpec, intent: CloudInstallationIntent, driver: CloudInstallationDriver): CloudInstallationIntent {
  try {
    if (!driver.deployment?.prepareIntent || intent.purpose !== 'deployment' || intent.mode !== 'connect') throw new CloudDeploymentAccessError('unsupported');
    return parseCloudInstallationIntentV1({ ...intent, deployment: driver.deployment.prepareIntent(spec, intent) }, driver);
  } catch (error) { if (error instanceof CloudDeploymentAccessError) throw error; throw new CloudDeploymentAccessError('invalid_contract'); }
}

function parseConnection(value: unknown, driver: CloudInstallationDriver) {
  if (!driver.deployment) throw new CloudDeploymentAccessError('unsupported');
  return parseCloudDeploymentConnectionV1(value, { provider: driver.provider, hostingProvider: driver.deployment.hostingProvider,
    parseScope: value => driver.parseScope(value), parsePreparedResources: driver.deployment.parsePreparedResources });
}
/** Provider-owned current-source validation, not authority inferred from receipt possession. */
export function assertCloudDeploymentSourcePlacementV1(spec: ProjectSpec, connection: CloudDeploymentConnectionV1, driver: CloudInstallationDriver): void {
  try {
    const parsed = parseConnection(connection, driver);
    if (!driver.deployment?.assertSourcePlacement) throw new CloudDeploymentAccessError('unsupported');
    driver.deployment.assertSourcePlacement(spec, parsed);
  } catch (error) { if (error instanceof CloudDeploymentAccessError) throw error; throw new CloudDeploymentAccessError('scope_mismatch'); }
}

/** Pure proposal. Caller independently verifies native repository/default branch/source and owns approval/CAS. */
export function prepareCloudDeploymentSourceAuthorizationV1(input: {
  connection: CloudDeploymentConnectionV1; previous?: CloudDeploymentSourceAuthorizationV1; id: string;
  source: CloudInstallationIntent['source']; spec: ProjectSpec; driver: CloudInstallationDriver;
}): CloudDeploymentSourceAuthorizationV1 {
  try {
    const connection = parseConnection(input.connection, input.driver);
    assertCloudDeploymentSourcePlacementV1(input.spec, connection, input.driver);
    const fields = { schemaVersion: 1 as const, id: input.id, connectionDigest: canonicalJsonSha256(connection),
      previousDigest: cloudDeploymentSourceAuthorityDigestV1(connection, input.previous),
      from: cloudDeploymentEffectiveSourceV1(connection, input.previous), source: input.source };
    if (input.previous?.id === input.id) throw new CloudDeploymentAccessError('scope_mismatch');
    return parseCloudDeploymentSourceAuthorizationV1({ ...fields, digest: canonicalJsonSha256(fields) }, connection);
  } catch (error) { if (error instanceof CloudDeploymentAccessError) throw error; throw new CloudDeploymentAccessError('invalid_contract'); }
}

interface DeploymentAuthorityInput {
  connection: CloudDeploymentConnectionV1; driver: CloudInstallationDriver;
  authentication: Pick<CloudInstallationAuthentication, 'host'>;
  authorize(): Promise<boolean>; signal: AbortSignal;
}
interface VerifiedDeploymentBoundary {
  connection: CloudDeploymentConnectionV1;
  host: CloudInstallationAuthentication['host'];
  signal: AbortSignal;
  verify(): Promise<void>;
  wait<T>(work: () => Promise<T>): Promise<T>;
}
async function withDeploymentAuthority<T>(input: DeploymentAuthorityInput,
  work: (boundary: VerifiedDeploymentBoundary) => Promise<T>): Promise<T> {
  const controller = new AbortController(), cancel = () => controller.abort();
  input.signal.addEventListener('abort', cancel, { once: true });
  if (input.signal.aborted) controller.abort();
  const timer = setTimeout(cancel, 30_000); timer.unref?.();
  const signal = controller.signal;
  const wait = async <T>(work: () => Promise<T>): Promise<T> => {
    if (signal.aborted) throw new CloudDeploymentAccessError('authorization_unavailable');
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new CloudDeploymentAccessError('authorization_unavailable')); signal.addEventListener('abort', rejectAbort, { once: true }); });
    try { return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw new CloudDeploymentAccessError('authorization_unavailable');
      return work();
    }), aborted]); }
    finally { signal.removeEventListener('abort', rejectAbort); }
  };
  try {
    const connection = parseConnection(input.connection, input.driver);
    const verify = async () => {
      if (!await wait(input.authorize)) throw new CloudDeploymentAccessError('authorization_unavailable');
      if (!isDeepStrictEqual(await wait(() => input.authentication.host.verifyIdentity(signal)), connection.hostIdentity))
        throw new CloudDeploymentAccessError('scope_mismatch');
    };
    await verify();
    const host: CloudInstallationAuthentication['host'] = {
      verifyIdentity: async () => { await verify(); return structuredClone(connection.hostIdentity); },
      getIdToken: async audience => { await verify(); return wait(() => input.authentication.host.getIdToken(audience, signal)); },
      getAccessToken: async () => { await verify(); return wait(() => input.authentication.host.getAccessToken(signal)); },
    };
    return await wait(() => work({ connection, host, signal, verify, wait }));
  } catch (error) { if (error instanceof CloudDeploymentAccessError) throw error; throw new CloudDeploymentAccessError('authorization_unavailable'); }
  finally { clearTimeout(timer); input.signal.removeEventListener('abort', cancel); controller.abort(); }
}

/** Bounded transient session execution. This is not a command API or a durable credential object. */
export async function issueCloudDeploymentSessionV1(input: DeploymentAuthorityInput & {
  capability: CloudDeploymentCapability; target?: 'resource-manager' | 'container-registry';
}): Promise<CloudDeploymentSessionV1> {
  return withDeploymentAuthority(input, async ({ connection, host, signal, verify, wait }) => {
    const principal = connection.principals[input.capability];
    if (!principal || !['provision', 'release'].includes(input.capability)) throw new CloudDeploymentAccessError('scope_mismatch');
    if (principal.kind === 'azure-managed-identity' ? !['resource-manager', 'container-registry'].includes(input.target ?? '') : input.target !== undefined)
      throw new CloudDeploymentAccessError('scope_mismatch');
    const issue = input.driver.deployment?.issueSession;
    if (!issue) throw new CloudDeploymentAccessError('unsupported');
    let authorizedImmediatelyBeforeIssue = false;
    const response = await wait(() => issue({ connection, capability: input.capability, ...(input.target ? { target: input.target } : {}), host, signal,
      beforeIssue: async () => { await verify(); authorizedImmediatelyBeforeIssue = true; } }));
    const session = parseCloudDeploymentSessionV1(response);
    if (!authorizedImmediatelyBeforeIssue || !isDeepStrictEqual(session.principal, principal)
      || session.kind === 'azure-federation' && session.target !== input.target || signal.aborted) throw new CloudDeploymentAccessError('scope_mismatch');
    // Native issuance can complete after the requesting member/device is revoked.
    // Withhold the session even though its native expiry cannot be shortened here.
    await verify();
    return session;
  });
}

const sourceSchema = z.object({ repository: z.string().regex(/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  branch: sourceBranchSchema, revision: z.string().regex(/^[a-f0-9]{40}$/), specDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const resourceIdentity = z.object({ id: z.string().regex(/^[A-Za-z0-9/_.:@+-]{1,2048}$/),
  lifetimeId: z.string().regex(/^[A-Za-z0-9_.:@+-]{1,160}$/) }).strict();
const releaseTargetsSchema = z.array(z.object({ workload: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
  kind: z.enum(['service', 'job']), service: resourceIdentity, registry: resourceIdentity }).strict()).max(50);

/** Native target proof, never adoption or an assertion that the application candidate equals the workflow SHA. */
export async function verifyCloudDeploymentReleaseTargetsV1(input: DeploymentAuthorityInput & {
  spec: ProjectSpec; bindings: unknown; source: CloudInstallationIntent['source']; sourceAuthorization?: CloudDeploymentSourceAuthorizationV1;
}): Promise<CloudDeploymentReleaseTargetsV1> {
  return withDeploymentAuthority(input, async ({ connection, host, signal, verify, wait }) => {
    const source = sourceSchema.parse(input.source);
    const effective = cloudDeploymentEffectiveSourceV1(connection, input.sourceAuthorization);
    if (source.repository !== effective.repository || source.branch !== effective.branch)
      throw new CloudDeploymentAccessError('scope_mismatch');
    assertCloudDeploymentSourcePlacementV1(input.spec, connection, input.driver);
    const capability = input.driver.deployment;
    if (!capability?.verifyReleaseTargets || !capability.parseReleaseTargets) throw new CloudDeploymentAccessError('unsupported');
    const observed = await wait(() => capability.verifyReleaseTargets!({ connection, spec: input.spec, bindings: input.bindings,
      source, host, signal, beforeIssue: verify }));
    const targets = releaseTargetsSchema.parse(capability.parseReleaseTargets(releaseTargetsSchema.parse(observed), connection));
    if (targets.length !== connection.deployment.workloads.length || new Set(targets.map(target => target.workload)).size !== targets.length
      || new Set(targets.map(target => target.service.id)).size !== targets.length
      || targets.some(target => !connection.deployment.workloads.some(workload => workload.name === target.workload)))
      throw new CloudDeploymentAccessError('scope_mismatch');
    await verify();
    return { schemaVersion: 1, installationId: connection.installationId, provider: connection.provider, hostingProvider: connection.hostingProvider,
      customerId: connection.customerId, appId: connection.appId, environment: connection.environment, source, targets };
  });
}
