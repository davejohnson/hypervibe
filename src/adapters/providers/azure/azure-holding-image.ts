import { DestinationBudget } from '../secret-destination-http.js';
import { azureHoldingImageSchema } from './azure-prepared-hosting.js';

/** Anonymous metadata proof for the operator's public immutable holding image.
 * This never forwards an administrator token and does not claim a live ACA pull.
 */
export async function verifyAzureHoldingImage(image: string, options: { fetch?: typeof fetch; signal?: AbortSignal; deadlineMs?: number } = {}): Promise<void> {
  let budget: DestinationBudget | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    azureHoldingImageSchema.parse(image);
    budget = new DestinationBudget({ signal: options.signal, deadlineMs: options.deadlineMs });
    if (budget.signal.aborted) throw new Error();
    const [host, project, repository, ...tail] = image.split('/');
    const location = host.slice(0, -'-docker.pkg.dev'.length), imageName = tail.join('/');
    const parent = `projects/${project}/locations/${location}/repositories/${repository}/dockerImages/`;
    const url = `https://artifactregistry.googleapis.com/v1/${parent}${encodeURIComponent(imageName)}`;
    const response = await budget.wait((options.fetch ?? fetch)(url, { redirect: 'error', signal: budget.signal }));
    if (!response.ok || response.redirected || response.url && response.url !== url || !response.body) {
      void response.body?.cancel().catch(() => {}); throw new Error();
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const chunk = await budget.wait(reader.read()); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 65536) throw new Error(); chunks.push(chunk.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || (result as Record<string, unknown>).name !== `${parent}${imageName}` || (result as Record<string, unknown>).uri !== image) throw new Error();
  } catch {
    void reader?.cancel().catch(() => {});
    throw new Error('The exact public holding image could not be verified.');
  } finally { reader?.releaseLock(); budget?.close(); }
}
