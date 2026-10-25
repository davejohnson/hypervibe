import { createHash } from 'node:crypto';
import { CloudInstallationBoundaryError } from '../../../domain/ports/cloud-installation.port.js';
import { DestinationBudget } from '../secret-destination-http.js';

/** Operator-published, nonsecret templates: regional S3 REST HTTPS, pinned object version.
 * CloudFormation does not accept arbitrary HTTPS or S3 website TemplateURLs.
 * S3's literal null version is overwriteable, even with a digest-named object key.
 */
export async function verifyAwsCloudFormationPublication(options: {
  templateUrl?: string; sha256: string; signal: AbortSignal; fetch?: typeof fetch;
}): Promise<string> {
  let url: URL, version: string;
  try {
    url = new URL(options.templateUrl ?? '');
    version = url.searchParams.get('versionId') ?? '';
    // This driver hands off to the console (1,024 characters), not CreateStack's wider API limit.
    if (url.toString().length > 1024 || url.protocol !== 'https:'
      || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
      || url.username || url.password || url.port || url.hash
      || [...url.searchParams].length !== 1 || !version || version === 'null'
      || /[\u0000-\u0020\u007f]/.test(version) || Buffer.byteLength(version, 'utf8') > 1024
      || !url.pathname.endsWith(`/${options.sha256}.json`)) throw new Error();
  } catch { throw new CloudInstallationBoundaryError('not_installed'); }
  const address = url.toString(), budget = new DestinationBudget({ signal: options.signal });
  try {
    if (budget.signal.aborted) throw new CloudInstallationBoundaryError('cancelled');
    const response = await budget.wait((options.fetch ?? fetch)(address, { redirect: 'error', signal: budget.signal }));
    if (response.status !== 200 || response.redirected || response.url !== address
      || response.headers.get('x-amz-version-id') !== version || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new CloudInstallationBoundaryError('identity_mismatch');
    }
    const reader = response.body.getReader(), digest = createHash('sha256'); let bytes = 0;
    try {
      for (;;) {
        const item = await budget.wait(reader.read()); if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 1_048_576) throw new CloudInstallationBoundaryError('identity_mismatch');
        digest.update(item.value);
      }
      if (digest.digest('hex') !== options.sha256) throw new CloudInstallationBoundaryError('identity_mismatch');
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return address;
  } finally { budget.close(); }
}
