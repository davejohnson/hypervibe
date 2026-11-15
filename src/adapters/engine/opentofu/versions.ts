/**
 * Pinned OpenTofu engine release. Deployments use exactly this version and the
 * checksums below; upgrading is a reviewed code change, never automatic.
 *
 * Source: https://github.com/opentofu/opentofu/releases/tag/v1.13.9 (tofu_1.13.9_SHA256SUMS)
 */
export const OPENTOFU_VERSION = '1.13.9';

export type EnginePlatform = 'darwin_arm64' | 'darwin_amd64' | 'linux_amd64' | 'linux_arm64';

export const OPENTOFU_ARCHIVE_SHA256: Record<EnginePlatform, string> = {
  darwin_arm64: '29ba2f4c78556a8d25476e5070fe4745495ef649c4a3b827170eb7436d23feb3',
  darwin_amd64: 'ac5505dd19d896f327d0ab727d4b853413c694931a7602b31f93c3a3e9d46d00',
  linux_amd64: 'bc44eb6b06446ba83bd4072114891987f590f66cca712737a7f1147c50c539ce',
  linux_arm64: '04f7c93828b859d420269ed30f923ffebf09157b5d7fb95bf8d88a4d208b7fa3',
};

export function currentEnginePlatform(): EnginePlatform | undefined {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : undefined;
  if (!os || !arch) return undefined;
  return `${os}_${arch}` as EnginePlatform;
}
