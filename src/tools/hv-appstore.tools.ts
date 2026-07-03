import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import type { ToolContext } from './context.js';
import { toolSuccess, toolError, wrapHandler, HvError, describeError } from './respond.js';
import {
  addTestersToGroup,
  getAppStoreConnectAdapter,
  resolveAppId,
  resolveBuild,
  resolveBetaGroup,
  summarizeBuild,
  betaTesterInputSchema,
  IMAGE_EXTENSIONS,
  type BetaTesterInput,
} from '../domain/services/appstore-ops.service.js';
import { formatConnectionGuidance } from '../domain/services/connection-guidance.js';
import type {
  AppStoreConnectAdapter,
  AppStoreBetaGroup,
  AppStoreConnectBuild,
} from '../adapters/providers/appstoreconnect/appstoreconnect.adapter.js';
import { XcodeAdapter } from '../adapters/providers/xcode/xcode.adapter.js';

const SETUP_HINT =
  `${formatConnectionGuidance('appstoreconnect')} For multiple apps/teams use a scoped connection (scope="<bundle id>"). Uploads additionally require the Xcode command line tools (xcode-select --install).`;

/** Shared field used by every App Store Connect tool. */
const appIdentifierField = z.string().optional().describe('App bundle identifier (e.g. com.example.myapp), used for scoped connection lookup and app resolution');
const platformField = z.enum(['IOS', 'MAC_OS', 'TV_OS']).optional().describe('Platform (default: IOS)');
type AscPlatform = 'IOS' | 'MAC_OS' | 'TV_OS' | undefined;

function adapterOrThrow(scopeHint?: string): AppStoreConnectAdapter {
  const result = getAppStoreConnectAdapter(scopeHint);
  if ('error' in result) {
    throw new HvError('MISSING_CONNECTION', result.error, { hint: SETUP_HINT });
  }
  return result.adapter;
}

function unwrap<T extends object>(result: T | { error: string }): T {
  if ('error' in result) throw new HvError('PROVIDER_ERROR', result.error);
  return result;
}

/**
 * Compute App Store submission readiness for the editable version
 * (build attached, localization metadata, screenshots).
 */
async function computeReadiness(
  adapter: AppStoreConnectAdapter,
  appId: string,
  options: { platform?: AscPlatform; locale: string; screenshotDisplayType: string },
): Promise<Record<string, unknown>> {
  const version = await adapter.getEditableAppStoreVersion(appId, options.platform);
  if (!version) {
    return {
      version: null,
      missing: ['No editable App Store version found (expected PREPARE_FOR_SUBMISSION or similar state). Create a new version in App Store Connect.'],
    };
  }

  const build = await adapter.getAppStoreVersionBuild(version.id);
  const localizations = await adapter.listAppStoreVersionLocalizations(version.id);
  const localization = localizations.find((l) => l.locale.toLowerCase() === options.locale.toLowerCase()) ?? null;

  let screenshotSet: { id: string; screenshotDisplayType: string } | null = null;
  let screenshots: Array<{ id: string; fileName?: string; state?: string }> = [];
  if (localization) {
    const sets = await adapter.listAppScreenshotSets(localization.id);
    screenshotSet = sets.find((s) => s.screenshotDisplayType === options.screenshotDisplayType) ?? null;
    if (screenshotSet) {
      const items = await adapter.listAppScreenshots(screenshotSet.id);
      screenshots = items.map((s) => ({ id: s.id, fileName: s.fileName, state: s.assetDeliveryState?.state }));
    }
  }

  const checks = {
    hasBuildAttached: !!build,
    hasLocalization: !!localization,
    hasDescription: !!localization?.description,
    hasWhatsNew: !!localization?.whatsNew,
    hasScreenshotSet: !!screenshotSet,
    screenshotCount: screenshots.length,
  };
  const missing: string[] = [];
  if (!checks.hasBuildAttached) missing.push('Attach a build to the App Store version');
  if (!checks.hasLocalization) missing.push(`Create localization ${options.locale}`);
  if (checks.hasLocalization && !checks.hasDescription) missing.push(`Set description for ${options.locale}`);
  if (checks.hasLocalization && !checks.hasWhatsNew) missing.push(`Set what's new for ${options.locale}`);
  if (checks.hasLocalization && !checks.hasScreenshotSet) missing.push(`Create screenshot set ${options.screenshotDisplayType} for ${options.locale}`);
  if (checks.hasScreenshotSet && checks.screenshotCount === 0) missing.push(`Upload at least one screenshot for ${options.locale}/${options.screenshotDisplayType}`);

  return {
    version,
    locale: options.locale,
    screenshotDisplayType: options.screenshotDisplayType,
    readinessChecks: checks,
    missing,
    localizations: localizations.map((l) => ({
      id: l.id,
      locale: l.locale,
      hasDescription: !!l.description,
      hasWhatsNew: !!l.whatsNew,
    })),
    screenshotSet,
    screenshots,
  };
}

const STATUS_SECTIONS = ['builds', 'groups', 'testers', 'readiness', 'capabilities'] as const;
type StatusSection = (typeof STATUS_SECTIONS)[number];

export function registerHvAppstoreTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'hv_appstore_status',
    'Read-only App Store Connect overview for an app: TestFlight builds, beta groups, testers, App Store submission readiness, and App ID capabilities. Use include to limit scope. Requires an appstoreconnect connection (API key from https://appstoreconnect.apple.com/access/integrations/api).',
    {
      appIdentifier: z.string().describe('App bundle identifier (e.g. com.example.myapp)'),
      include: z.array(z.enum(STATUS_SECTIONS)).optional().describe('Sections to include (default: all of builds, groups, testers, readiness, capabilities)'),
      platform: platformField,
      locale: z.string().optional().describe('Localization to inspect for readiness (default: en-US)'),
      screenshotDisplayType: z.string().optional().describe('Screenshot display type to inspect for readiness (default: APP_IPHONE_65)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max builds/testers to return (default: 10 builds, 200 testers)'),
    },
    wrapHandler(async ({ appIdentifier, include, platform, locale = 'en-US', screenshotDisplayType = 'APP_IPHONE_65', limit }) => {
      const adapter = adapterOrThrow(appIdentifier);
      const sections = new Set<StatusSection>(include?.length ? include : STATUS_SECTIONS);
      const warnings: string[] = [];

      const app = await adapter.findAppByBundleId(appIdentifier);
      if (!app && (sections.has('builds') || sections.has('groups') || sections.has('testers') || sections.has('readiness'))) {
        throw new HvError('NOT_FOUND', `App not found for bundle ID: ${appIdentifier}.`, {
          hint: 'Create the app in App Store Connect first, or check the bundle identifier. App ID capabilities can still be checked once the bundle ID is registered (hv_appid_register).',
        });
      }

      const data: Record<string, unknown> = { app };
      const section = async (name: StatusSection, fn: () => Promise<unknown>) => {
        if (!sections.has(name)) return;
        try {
          data[name] = await fn();
        } catch (error) {
          warnings.push(`Failed to load ${name}: ${describeError(error)}`);
        }
      };

      await section('builds', async () => {
        const builds = await adapter.listBuilds({ appId: app!.id, limit: limit ?? 10 });
        return builds.map(summarizeBuild);
      });
      await section('groups', () => adapter.listBetaGroups(app!.id));
      await section('testers', () => adapter.listBetaTesters({ appId: app!.id, limit: limit ?? 200 }));
      await section('readiness', () => computeReadiness(adapter, app!.id, { platform, locale, screenshotDisplayType }));
      await section('capabilities', async () => {
        const bundleId = await adapter.findBundleIdByIdentifier(appIdentifier);
        if (!bundleId) return { bundleId: null, capabilities: [], note: `Bundle ID not registered: ${appIdentifier}. Register it with hv_appid_register.` };
        return { bundleId, capabilities: await adapter.getBundleIdCapabilities(bundleId.id) };
      });

      return toolSuccess(data, { warnings });
    })
  );

  server.tool(
    'hv_testflight_upload',
    'Upload an IPA to TestFlight via xcrun altool, then wait for processing and set export compliance in one flow (required before the build appears in TestFlight). Optionally distribute to beta groups and submit for external beta review. Requires Xcode command line tools (xcode-select --install).',
    {
      ipaPath: z.string().describe('Path to the IPA file'),
      appIdentifier: appIdentifierField,
      appId: z.string().optional().describe('App Store Connect app ID (numeric)'),
      buildNumber: z.string().optional().describe('Specific build number to set compliance on (default: most recent build)'),
      usesNonExemptEncryption: z.boolean().optional().describe('Does the app use non-exempt encryption? (default: false - standard HTTPS only)'),
      skipCompliance: z.boolean().optional().describe('Upload only; skip waiting for processing and setting export compliance (default: false)'),
      distributeToGroups: z.array(z.string()).optional().describe('Beta group names to distribute to after compliance is set'),
      submitForBetaReview: z.boolean().optional().describe('Submit for external beta review after compliance (default: false)'),
    },
    wrapHandler(async ({ ipaPath, appIdentifier, appId, buildNumber, usesNonExemptEncryption, skipCompliance, distributeToGroups, submitForBetaReview }) => {
      const adapter = adapterOrThrow(appIdentifier);

      const uploadResult = await adapter.uploadViaAltool(ipaPath);
      ctx.repos.audit.create({
        action: 'testflight.upload',
        resourceType: 'testflight',
        resourceId: ipaPath,
        details: { success: uploadResult.success },
      });
      if (!uploadResult.success) {
        return toolError('PROVIDER_ERROR', uploadResult.error ?? 'Upload failed', {
          details: { output: uploadResult.output?.substring(0, 2000) },
          hint: 'Check that the IPA path is valid and Xcode command line tools are installed (xcode-select --install).',
        });
      }
      if (skipCompliance) {
        return toolSuccess({ uploaded: true, ipaPath }, {
          hint: 'Re-run with skipCompliance=false (or use hv_testflight_distribute) to set export compliance once processing finishes.',
        });
      }

      const compliance = await adapter.waitForProcessingAndSetCompliance({
        appId,
        buildNumber,
        usesNonExemptEncryption: usesNonExemptEncryption ?? false,
      });
      if (compliance.error || !compliance.build) {
        return toolError('PROVIDER_ERROR', compliance.error ?? 'No processed build found after upload', {
          details: compliance.build ? { build: summarizeBuild(compliance.build) } : undefined,
          hint: 'Processing can take a while. Re-run hv_appstore_status include=["builds"] to check, then hv_testflight_distribute once the build is VALID.',
        });
      }

      const build = compliance.build;
      const actions: string[] = ['Uploaded IPA to App Store Connect'];
      if (compliance.complianceSet) {
        actions.push(`Export compliance set (usesNonExemptEncryption: ${usesNonExemptEncryption ?? false})`);
      } else if (build.usesNonExemptEncryption !== null) {
        actions.push('Export compliance was already set');
      }

      const warnings: string[] = [];
      if (distributeToGroups?.length && build.appId) {
        const groups = await adapter.listBetaGroups(build.appId);
        for (const groupName of distributeToGroups) {
          const group = groups.find((g) => g.name.toLowerCase() === groupName.toLowerCase());
          if (group) {
            await adapter.addBuildToBetaGroup(build.id, group.id);
            actions.push(`Added to beta group: ${group.name}`);
          } else {
            warnings.push(`Beta group not found: ${groupName} (available: ${groups.map((g) => g.name).join(', ')})`);
          }
        }
      }
      if (submitForBetaReview) {
        await adapter.submitForBetaReview(build.id);
        actions.push('Submitted for external beta review');
      }

      ctx.repos.audit.create({
        action: 'testflight.compliance',
        resourceType: 'testflight',
        resourceId: build.id,
        details: { buildNumber: build.buildNumber, version: build.version, complianceSet: compliance.complianceSet, actions },
      });

      return toolSuccess(
        { ipaPath, build: summarizeBuild(build), actions },
        { hint: 'Build is ready for TestFlight. Use hv_testflight_distribute to attach it to a beta group and add testers.', warnings, next: ['hv_testflight_distribute'] }
      );
    })
  );

  server.tool(
    'hv_testflight_distribute',
    'Distribute on TestFlight: prepare a build (waits for processing and sets export compliance), attach it to a beta group (created if missing), and add testers. Pass skipBuild=true to only manage the group and testers without touching builds.',
    {
      appIdentifier: appIdentifierField,
      appId: z.string().optional().describe('App Store Connect app ID (numeric)'),
      buildId: z.string().optional().describe('Specific App Store Connect build ID'),
      buildNumber: z.string().optional().describe('Specific build number (default: most recent processed build)'),
      skipBuild: z.boolean().optional().describe('Only create/find the group and add testers; do not attach a build (default: false)'),
      groupId: z.string().optional().describe('Existing beta group ID'),
      groupName: z.string().optional().describe('Beta group name to use or create (default: External Testers)'),
      createGroupIfMissing: z.boolean().optional().describe('Create groupName if not found (default: true)'),
      groupType: z.enum(['external', 'internal']).optional().describe('Group type when creating (default: external)'),
      testers: z.array(betaTesterInputSchema).optional().describe('Testers to create or add to the group'),
      usesNonExemptEncryption: z.boolean().optional().describe('Does the app use non-exempt encryption? (default: false - standard HTTPS only)'),
      submitForBetaReview: z.boolean().optional().describe('Submit build for external beta review after distribution (default: false)'),
      hasAccessToAllBuilds: z.boolean().optional().describe('When creating a group, allow access to all builds'),
      feedbackEnabled: z.boolean().optional().describe('When creating a group, enable TestFlight feedback'),
      publicLinkEnabled: z.boolean().optional().describe('When creating an external group, enable public invite link'),
      publicLinkLimit: z.number().int().min(1).max(10000).optional().describe('When enabling public link, cap testers between 1 and 10000'),
    },
    wrapHandler(async ({
      appIdentifier, appId, buildId, buildNumber, skipBuild, groupId, groupName = 'External Testers',
      createGroupIfMissing = true, groupType = 'external', testers = [], usesNonExemptEncryption,
      submitForBetaReview = false, hasAccessToAllBuilds, feedbackEnabled, publicLinkEnabled, publicLinkLimit,
    }) => {
      const adapter = adapterOrThrow(appIdentifier);
      const appResolution = unwrap(await resolveAppId(adapter, appIdentifier, appId));
      const actions: string[] = [];

      let build: AppStoreConnectBuild | null = null;
      if (!skipBuild) {
        const buildResolution = unwrap(await resolveBuild(adapter, {
          appId: appResolution.appId,
          buildId,
          buildNumber,
          usesNonExemptEncryption,
        }));
        build = buildResolution.build;
        if (buildResolution.complianceSet) {
          actions.push(`Export compliance set (usesNonExemptEncryption: ${usesNonExemptEncryption ?? false})`);
        }
      }

      const effectiveAppId = build?.appId || appResolution.appId;
      const groupResolution = unwrap(await resolveBetaGroup(adapter, {
        appId: effectiveAppId,
        groupId,
        groupName,
        createIfMissing: createGroupIfMissing,
        groupType,
        hasAccessToAllBuilds,
        feedbackEnabled,
        publicLinkEnabled,
        publicLinkLimit,
      }));
      if (groupResolution.created) {
        actions.push(`Created beta group: ${groupResolution.group.name}`);
      }

      if (build) {
        await adapter.addBuildToBetaGroup(build.id, groupResolution.group.id);
        actions.push(`Added build ${build.buildNumber} to beta group: ${groupResolution.group.name}`);
      }

      const testerResults = await addTestersToGroup(adapter, effectiveAppId, groupResolution.group, testers as BetaTesterInput[]);
      if (testerResults.length > 0) {
        actions.push(`Added ${testerResults.length} tester(s) to ${groupResolution.group.name}`);
      }

      if (submitForBetaReview && build) {
        await adapter.submitForBetaReview(build.id);
        actions.push('Submitted build for external beta review');
      }

      ctx.repos.audit.create({
        action: 'testflight.distribute',
        resourceType: 'testflight',
        resourceId: build?.id ?? groupResolution.group.id,
        details: { appId: effectiveAppId, groupId: groupResolution.group.id, testerCount: testerResults.length, submitForBetaReview, skipBuild: !!skipBuild },
      });

      return toolSuccess({
        appId: effectiveAppId,
        ...(build ? { build: summarizeBuild(build) } : {}),
        group: groupResolution.group,
        groupCreated: groupResolution.created,
        testers: testerResults,
        actions,
      });
    })
  );

  server.tool(
    'hv_appstore_submit',
    'Submit an app version for App Store review. The app must have a version in PREPARE_FOR_SUBMISSION state with a build attached (check with hv_appstore_status include=["readiness"]).',
    {
      appIdentifier: z.string().describe('App bundle identifier (e.g. com.example.myapp)'),
      platform: platformField,
    },
    wrapHandler(async ({ appIdentifier, platform }) => {
      const adapter = adapterOrThrow(appIdentifier);

      const app = await adapter.findAppByBundleId(appIdentifier);
      if (!app) {
        return toolError('NOT_FOUND', `App not found for bundle ID: ${appIdentifier}.`, {
          hint: 'Create the app in App Store Connect first.',
        });
      }

      const version = await adapter.getEditableAppStoreVersion(app.id, platform as AscPlatform);
      if (!version) {
        const versions = await adapter.listAppStoreVersions(app.id, { platform: platform as AscPlatform, limit: 5 });
        return toolError('VALIDATION', 'No version ready for submission. Create a new version in App Store Connect with state PREPARE_FOR_SUBMISSION.', {
          details: { currentVersions: versions.map((v) => ({ version: v.versionString, state: v.appStoreState, platform: v.platform })) },
        });
      }

      const build = await adapter.getAppStoreVersionBuild(version.id);
      if (!build) {
        return toolError('VALIDATION', `Version ${version.versionString} has no build attached. Select a build in App Store Connect first.`, {
          details: { version: { versionString: version.versionString, state: version.appStoreState } },
          hint: 'Upload one with hv_testflight_upload, then attach it to the version.',
        });
      }

      await adapter.submitForReview(version.id);
      ctx.repos.audit.create({
        action: 'appstore.submit',
        resourceType: 'appstore',
        resourceId: app.id,
        details: { appIdentifier, version: version.versionString, buildNumber: build.version },
      });

      return toolSuccess({
        message: 'App submitted for App Store review',
        app,
        version: { id: version.id, versionString: version.versionString, previousState: version.appStoreState },
        build: { id: build.id, buildNumber: build.version },
      });
    })
  );

  server.tool(
    'hv_appstore_assets',
    'Prepare App Store submission assets: create/update localization metadata (description, keywords, what\'s new, URLs) and upload screenshots for the editable app version.',
    {
      appIdentifier: z.string().describe('App bundle identifier (e.g. com.example.myapp)'),
      platform: platformField,
      locale: z.string().optional().describe('Localization locale (default: en-US)'),
      screenshotDisplayType: z.string().optional().describe('Screenshot display type (default: APP_IPHONE_65)'),
      screenshotDir: z.string().optional().describe('Directory containing screenshots (.png/.jpg/.jpeg), uploaded in filename sort order'),
      replaceScreenshots: z.boolean().optional().describe('Delete existing screenshots in the set before uploading (default: false)'),
      description: z.string().optional().describe('Localized App Store description'),
      keywords: z.string().optional().describe('Localized keywords (comma-separated)'),
      promotionalText: z.string().optional().describe('Localized promotional text'),
      marketingUrl: z.string().optional().describe('Localized marketing URL'),
      supportUrl: z.string().optional().describe('Localized support URL'),
      whatsNew: z.string().optional().describe('Localized what\'s new text'),
    },
    wrapHandler(async ({
      appIdentifier, platform, locale = 'en-US', screenshotDisplayType = 'APP_IPHONE_65',
      screenshotDir, replaceScreenshots, description, keywords, promotionalText, marketingUrl, supportUrl, whatsNew,
    }) => {
      const adapter = adapterOrThrow(appIdentifier);

      const app = await adapter.findAppByBundleId(appIdentifier);
      if (!app) {
        return toolError('NOT_FOUND', `App not found for bundle ID: ${appIdentifier}.`, { hint: 'Create the app in App Store Connect first.' });
      }
      const version = await adapter.getEditableAppStoreVersion(app.id, platform as AscPlatform);
      if (!version) {
        return toolError('VALIDATION', 'No editable App Store version found (expected PREPARE_FOR_SUBMISSION or similar state).', {
          hint: 'Create a new version in App Store Connect, then retry.',
        });
      }

      const localization = await adapter.getOrCreateAppStoreVersionLocalization(version.id, locale);
      await adapter.updateAppStoreVersionLocalization(localization.id, {
        description, keywords, promotionalText, marketingUrl, supportUrl, whatsNew,
      });

      const uploadedScreenshots: Array<{ fileName: string; screenshotId: string }> = [];
      const deletedScreenshotIds: string[] = [];
      let screenshotSet: { id: string; screenshotDisplayType: string } | null = null;

      if (screenshotDir) {
        const entries = await readdir(screenshotDir);
        const files = entries
          .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (files.length === 0) {
          return toolError('VALIDATION', `No screenshot files found in ${screenshotDir}. Expected .png/.jpg/.jpeg files.`);
        }
        for (const file of files) {
          const info = await stat(path.join(screenshotDir, file));
          if (!info.isFile()) {
            return toolError('VALIDATION', `Path is not a file: ${path.join(screenshotDir, file)}`);
          }
        }

        screenshotSet = await adapter.getOrCreateAppScreenshotSet(localization.id, screenshotDisplayType);
        if (replaceScreenshots) {
          for (const item of await adapter.listAppScreenshots(screenshotSet.id)) {
            await adapter.deleteAppScreenshot(item.id);
            deletedScreenshotIds.push(item.id);
          }
        }
        for (const file of files) {
          const uploaded = await adapter.uploadAppScreenshot(screenshotSet.id, path.join(screenshotDir, file), file);
          uploadedScreenshots.push({ fileName: file, screenshotId: uploaded.screenshotId });
        }
      }

      ctx.repos.audit.create({
        action: 'appstore.assets.prepare',
        resourceType: 'appstore',
        resourceId: app.id,
        details: {
          appIdentifier,
          version: version.versionString,
          locale,
          screenshotDisplayType,
          metadataUpdated: {
            description: description !== undefined,
            keywords: keywords !== undefined,
            promotionalText: promotionalText !== undefined,
            marketingUrl: marketingUrl !== undefined,
            supportUrl: supportUrl !== undefined,
            whatsNew: whatsNew !== undefined,
          },
          screenshotUploads: uploadedScreenshots.length,
          screenshotReplaced: replaceScreenshots ?? false,
        },
      });

      return toolSuccess(
        {
          message: 'App Store submission assets prepared',
          app,
          version: { id: version.id, versionString: version.versionString, state: version.appStoreState },
          localization: { id: localization.id, locale },
          screenshotSet,
          deletedScreenshotIds,
          uploadedScreenshots,
        },
        { next: ['hv_appstore_status', 'hv_appstore_submit'] }
      );
    })
  );

  server.tool(
    'hv_appid_register',
    'Register a new App ID (Bundle ID) on App Store Connect and optionally enable capabilities (e.g. PUSH_NOTIFICATIONS, ICLOUD, SIGN_IN_WITH_APPLE). Use hv_appstore_status include=["capabilities"] to inspect existing capabilities.',
    {
      identifier: z.string().describe('Bundle identifier (e.g. com.example.myapp)'),
      name: z.string().describe('Human-readable name for the App ID'),
      platform: z.enum(['IOS', 'MAC_OS']).optional().describe('Platform (default: IOS)'),
      capabilities: z.array(z.string()).optional().describe('Capability types to enable (e.g. PUSH_NOTIFICATIONS, ICLOUD, SIGN_IN_WITH_APPLE)'),
      appIdentifier: z.string().optional().describe('Scope hint for connection lookup'),
    },
    wrapHandler(async ({ identifier, name, platform, capabilities, appIdentifier }) => {
      const adapter = adapterOrThrow(appIdentifier);

      const bundleId = await adapter.registerBundleId(identifier, name, platform ?? 'IOS');
      let capabilityResults: { enabled: string[]; alreadyEnabled: string[]; errors: Array<{ type: string; error: string }> } | undefined;
      if (capabilities?.length) {
        capabilityResults = await adapter.enableCapabilities(bundleId.id, capabilities);
      }

      ctx.repos.audit.create({
        action: 'appid.register',
        resourceType: 'bundleId',
        resourceId: bundleId.id,
        details: { identifier, name, platform: platform ?? 'IOS', capabilities: capabilityResults },
      });

      return toolSuccess({
        bundleId,
        ...(capabilityResults ? { capabilities: capabilityResults } : {}),
      });
    })
  );

  server.tool(
    'hv_xcode_deploy',
    'Xcode device workflow. action="devices" lists devices available on network/USB; action="discover" finds the workspace/project and schemes in a directory; action="deploy" (default) builds a scheme and installs it on a connected device. Deploy without deviceId returns the device list; without scheme it auto-discovers the project.',
    {
      action: z.enum(['deploy', 'devices', 'discover']).optional().describe('Operation (default: deploy)'),
      scheme: z.string().optional().describe('Xcode scheme to build'),
      deviceId: z.string().optional().describe('Device identifier to install on'),
      workspace: z.string().optional().describe('Workspace file name (e.g. MyApp.xcworkspace)'),
      project: z.string().optional().describe('Project file name (e.g. MyApp.xcodeproj)'),
      configuration: z.string().optional().describe('Build configuration (Debug or Release, default: Debug)'),
      cwd: z.string().optional().describe('Working directory containing the Xcode project'),
    },
    wrapHandler(async ({ action = 'deploy', scheme, deviceId, workspace, project, configuration, cwd }) => {
      const adapter = new XcodeAdapter();

      if (action === 'devices') {
        const devices = await adapter.listDevices();
        return toolSuccess({ count: devices.length, devices });
      }
      if (action === 'discover') {
        const discovered = await adapter.discoverProject(cwd);
        return toolSuccess(discovered);
      }

      // action === 'deploy'
      if (!deviceId) {
        const devices = await adapter.listDevices();
        return toolSuccess(
          { devices },
          { hint: 'No deviceId provided. Re-run hv_xcode_deploy with deviceId set to one of the listed devices.' }
        );
      }

      let resolvedScheme = scheme;
      let resolvedWorkspace = workspace;
      let resolvedProject = project;
      if (!resolvedScheme) {
        const projectInfo = await adapter.discoverProject(cwd);
        resolvedWorkspace = resolvedWorkspace ?? projectInfo.workspace;
        resolvedProject = resolvedProject ?? projectInfo.project;
        if (projectInfo.schemes.length === 0) {
          return toolError('VALIDATION', 'No schemes found in project. Specify a scheme explicitly.');
        }
        if (projectInfo.schemes.length > 1) {
          return toolSuccess(
            { schemes: projectInfo.schemes, workspace: projectInfo.workspace, project: projectInfo.project },
            { hint: 'Multiple schemes found. Re-run hv_xcode_deploy with scheme set to one of them.' }
          );
        }
        resolvedScheme = projectInfo.schemes[0];
      }

      const buildResult = await adapter.build({
        scheme: resolvedScheme!,
        deviceId,
        workspace: resolvedWorkspace,
        project: resolvedProject,
        configuration: configuration ?? 'Debug',
        cwd,
      });
      if (!buildResult.success) {
        return toolError('PROVIDER_ERROR', buildResult.error ?? 'Build failed', {
          details: { phase: 'build', output: buildResult.output?.substring(0, 3000) },
        });
      }
      if (!buildResult.appPath) {
        return toolError('PROVIDER_ERROR', 'Build succeeded but .app path not found in DerivedData', {
          details: { phase: 'build', output: buildResult.output?.substring(0, 3000) },
        });
      }

      const installResult = await adapter.install(deviceId, buildResult.appPath);
      if (!installResult.success) {
        return toolError('PROVIDER_ERROR', installResult.error ?? 'Install failed', {
          details: { phase: 'install', appPath: buildResult.appPath, output: installResult.output?.substring(0, 3000) },
        });
      }

      return toolSuccess({
        message: `Built and installed ${resolvedScheme} on device`,
        scheme: resolvedScheme,
        deviceId,
        appPath: buildResult.appPath,
        configuration: configuration ?? 'Debug',
      });
    })
  );
}
