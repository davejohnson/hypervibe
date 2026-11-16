/** The environment variable that carries an engine database's connection URL. */
export const ENGINE_DATABASE_URL_KEY = 'DATABASE_URL';

/** Secret container id the managed engine uses for one environment variable. */
export function engineSecretId(environmentName: string, key: string): string {
  const id = `hv-${environmentName}-${key}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  if (id.length > 255) throw new Error(`Secret id for ${key} is too long.`);
  return id;
}
