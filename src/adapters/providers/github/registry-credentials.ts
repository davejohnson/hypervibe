import { z } from 'zod';
import type { RegistryCredentialSource } from '../../../domain/ports/registry-credentials.port.js';

const input = z.object({ login: z.string().min(1), packageReadToken: z.string().min(1) });
// GHCR implements the Docker registry token protocol. Keep credential-bearing
// requests on these exact origins/paths; never follow a challenge or redirect.
// https://distribution.github.io/distribution/spec/auth/token/
export const githubRegistryCredentials: RegistryCredentialSource = {
  resolve(credentials) {
    const parsed = input.safeParse(credentials);
    if (!parsed.success) throw new Error('Reconnect the repository code host with a login and package-read token.');
    return { username: parsed.data.login, token: parsed.data.packageReadToken };
  },
  async validate(image, credentials) {
    const parsed = /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)(?::([\w][\w.-]{0,127})|@(sha256:[a-f0-9]{64}))$/.exec(image);
    if (!parsed) throw new Error('Registry repair requires an existing GHCR image with an explicit tag or digest.');
    const [, repository, tag, digest] = parsed;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const url = new URL('https://ghcr.io/token');
      url.searchParams.set('service', 'ghcr.io');
      url.searchParams.set('scope', `repository:${repository}:pull`);
      const auth = await fetch(url, { redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString('base64')}` } });
      if (!auth.ok || !auth.body) { await auth.body?.cancel(); throw new Error(); }
      const reader = auth.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > 65_536) { await reader.cancel(); throw new Error(); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const token = z.string().min(1).max(32768);
      const result = z.object({ token: token.optional(), access_token: token.optional() })
        .refine(value => Boolean(value.token || value.access_token)
          && (!value.token || !value.access_token || value.token === value.access_token))
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const manifest = await fetch(`https://ghcr.io/v2/${repository}/manifests/${digest ?? tag}`, {
        method: 'HEAD', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${result.token ?? result.access_token}`,
          Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' },
      });
      await manifest.body?.cancel();
      if (manifest.status !== 200 || !/^sha256:[a-f0-9]{64}$/.test(manifest.headers.get('docker-content-digest') ?? '')
        || digest && manifest.headers.get('docker-content-digest') !== digest) throw new Error();
    } catch {
      throw new Error('Package-read credentials could not verify access to the existing image. No hosting update was authorized.');
    } finally { clearTimeout(timeout); }
  },
};
