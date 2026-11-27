import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const root = new URL('../', import.meta.url);
async function buildWorkers(output) {
  for (const provider of ['gcs', 's3', 'azure-blob', 'enrollment']) {
    await build({
      input: fileURLToPath(new URL('src/ci/' + provider + '-bucket-worker.ts', root)),
      platform: 'node',
      resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
      output: { format: 'cjs', file: fileURLToPath(new URL(output + '/' + provider + '.cjs', root)),
        minify: true, codeSplitting: false, comments: { legal: true } },
    });
  }
}

// Source-mode tests and packaged execution use the same workers. A build in a
// parallel job can replace dist/ without removing the test workers underneath it.
export default async function prepareTestWorkers() {
  await buildWorkers('node_modules/.cache/hypervibe-bucket-workers');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await buildWorkers('dist/bucket-workers');
