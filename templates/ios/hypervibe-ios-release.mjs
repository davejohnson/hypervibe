#!/usr/bin/env node

import { createPrivateKey, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const PROCESSING_INTERVAL_MS = 30 * 1000;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseBoolean(env, name, defaultValue = false) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["true", "1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function parseGroups(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("HYPERVIBE_TESTFLIGHT_GROUPS must be a JSON array");
  }
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((group) => typeof group !== "string" || !group.trim())
  ) {
    throw new Error("HYPERVIBE_TESTFLIGHT_GROUPS must contain at least one non-empty group name");
  }
  const groups = value.map((group) => group.trim());
  if (new Set(groups.map((group) => group.toLowerCase())).size !== groups.length) {
    throw new Error("HYPERVIBE_TESTFLIGHT_GROUPS contains duplicate group names");
  }
  return groups;
}

export function parseReleaseConfig(env = process.env, cwd = process.cwd()) {
  const keyId = required(env, "APP_STORE_CONNECT_KEY_ID");
  if (!/^[A-Za-z0-9]+$/.test(keyId)) {
    throw new Error("APP_STORE_CONNECT_KEY_ID contains unsupported characters");
  }
  const releaseSha = required(env, "HYPERVIBE_RELEASE_SHA");
  if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
    throw new Error("HYPERVIBE_RELEASE_SHA must be a full 40-character Git SHA");
  }
  const ipaPath = path.resolve(cwd, required(env, "HYPERVIBE_IPA_PATH"));
  if (path.extname(ipaPath).toLowerCase() !== ".ipa") {
    throw new Error("HYPERVIBE_IPA_PATH must point to an IPA");
  }

  return {
    keyId,
    issuerId: required(env, "APP_STORE_CONNECT_ISSUER_ID"),
    privateKey: required(env, "APP_STORE_CONNECT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    bundleId: required(env, "HYPERVIBE_BUNDLE_ID"),
    ipaPath,
    buildNumber: required(env, "HYPERVIBE_BUILD_NUMBER"),
    marketingVersion: required(env, "HYPERVIBE_MARKETING_VERSION"),
    groups: parseGroups(required(env, "HYPERVIBE_TESTFLIGHT_GROUPS")),
    usesNonExemptEncryption: parseBoolean(env, "HYPERVIBE_USES_NON_EXEMPT_ENCRYPTION"),
    submitForBetaReview: parseBoolean(env, "HYPERVIBE_SUBMIT_BETA_REVIEW"),
    environment: required(env, "HYPERVIBE_ENVIRONMENT"),
    releaseSha,
    repository: required(env, "GITHUB_REPOSITORY"),
    serverEvidencePath: path.resolve(
      cwd,
      env.HYPERVIBE_SERVER_EVIDENCE_PATH?.trim() || "hypervibe-server-release.json"
    ),
    outputPath: path.resolve(
      cwd,
      env.HYPERVIBE_IOS_RELEASE_OUTPUT?.trim() || "hypervibe-ios-release.json"
    ),
  };
}

export function buildAltoolArgs(config) {
  return [
    "altool",
    "--upload-app",
    "--type",
    "ios",
    "--file",
    config.ipaPath,
    "--apiKey",
    config.keyId,
    "--apiIssuer",
    config.issuerId,
  ];
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit",
      env,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(
        `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`
      ));
    });
  });
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function appStoreToken(config) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({
    alg: "ES256",
    kid: config.keyId,
    typ: "JWT",
  }));
  const payload = base64url(JSON.stringify({
    iss: config.issuerId,
    iat: now,
    exp: now + 15 * 60,
    aud: "appstoreconnect-v1",
  }));
  const body = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(body), {
    key: createPrivateKey(config.privateKey),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${body}.${signature}`;
}

async function appStoreRequest(config, requestPath, options = {}) {
  const { allowNotFound = false, ...requestOptions } = options;
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1${requestPath}`, {
    ...requestOptions,
    headers: {
      Authorization: `Bearer ${appStoreToken(config)}`,
      "Content-Type": "application/json",
      ...(requestOptions.headers || {}),
    },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(
      `App Store Connect returned ${response.status} for ${requestPath}: ${detail}`
    );
  }
  return response.status === 204 ? null : response.json();
}

async function findApp(config) {
  const response = await appStoreRequest(
    config,
    `/apps?filter[bundleId]=${encodeURIComponent(config.bundleId)}&limit=2`
  );
  if (response.data.length !== 1) {
    throw new Error(
      `Expected exactly one App Store Connect app for ${config.bundleId}, found ${response.data.length}`
    );
  }
  return response.data[0];
}

async function findBuild(config, appId) {
  const response = await appStoreRequest(
    config,
    `/builds?filter[app]=${encodeURIComponent(appId)}&filter[version]=${encodeURIComponent(config.buildNumber)}&limit=5`
  );
  const matches = response.data.filter(
    (candidate) => candidate.attributes.version === config.buildNumber
  );
  if (matches.length > 1) {
    throw new Error(
      `Found multiple App Store Connect builds numbered ${config.buildNumber}`
    );
  }
  const build = matches[0] || null;
  if (!build) return null;
  const preReleaseVersion = await appStoreRequest(
    config,
    `/builds/${build.id}/preReleaseVersion`
  );
  if (preReleaseVersion.data?.attributes?.version !== config.marketingVersion) {
    throw new Error(
      `Build ${config.buildNumber} belongs to marketing version `
      + `${preReleaseVersion.data?.attributes?.version || "(unknown)"}, not ${config.marketingVersion}`
    );
  }
  return build;
}

async function uploadIfNeeded(config, appId) {
  const existing = await findBuild(config, appId);
  if (existing) {
    console.log(
      `App Store Connect build ${config.buildNumber} already exists; resuming the gated release.`
    );
    return existing;
  }

  const keyDirectory = path.join(homedir(), ".appstoreconnect", "private_keys");
  const keyPath = path.join(keyDirectory, `AuthKey_${config.keyId}.p8`);
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });

  let createdKey = false;
  try {
    try {
      await access(keyPath, fsConstants.F_OK);
      const existingKey = (await readFile(keyPath, "utf8")).trim();
      if (existingKey !== config.privateKey.trim()) {
        throw new Error(
          `Refusing to overwrite an existing App Store Connect key at ${keyPath}`
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeFile(keyPath, config.privateKey, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(keyPath, 0o600);
      createdKey = true;
    }

    const childEnvironment = { ...process.env };
    delete childEnvironment.APP_STORE_CONNECT_PRIVATE_KEY;
    await run("xcrun", buildAltoolArgs(config), childEnvironment);
  } finally {
    if (createdKey) await unlink(keyPath).catch(() => {});
  }

  return null;
}

async function waitForProcessedBuild(config, appId, initialBuild = null) {
  let build = initialBuild;
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    build = build || await findBuild(config, appId);
    if (build?.attributes.processingState === "VALID") return build;
    if (build?.attributes.processingState === "FAILED") {
      throw new Error(`App Store Connect processing failed for build ${config.buildNumber}`);
    }
    build = null;
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for App Store Connect build ${config.buildNumber}`
  );
}

export function buildNeedsComplianceUpdate(build, usesNonExemptEncryption) {
  const current = build.attributes?.usesNonExemptEncryption;
  if (current === null || current === undefined) return true;
  if (current !== usesNonExemptEncryption) {
    throw new Error(
      "Existing App Store Connect export compliance does not match the release configuration"
    );
  }
  return false;
}

async function setCompliance(config, build) {
  if (!buildNeedsComplianceUpdate(build, config.usesNonExemptEncryption)) {
    console.log(
      `Build ${config.buildNumber} already has matching export compliance; skipping update.`
    );
    return;
  }
  await appStoreRequest(config, `/builds/${build.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "builds",
        id: build.id,
        attributes: {
          usesNonExemptEncryption: config.usesNonExemptEncryption,
        },
      },
    }),
  });
}

export function groupNeedsExplicitBuildAssignment(group) {
  return group.attributes?.hasAccessToAllBuilds !== true;
}

async function distributeToGroups(config, appId, build) {
  const response = await appStoreRequest(
    config,
    `/betaGroups?filter[app]=${encodeURIComponent(appId)}&limit=200`
  );
  for (const groupName of config.groups) {
    const matches = response.data.filter(
      (group) => group.attributes.name.toLowerCase() === groupName.toLowerCase()
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one declared TestFlight group named ${groupName}, found ${matches.length}`
      );
    }
    const group = matches[0];
    if (!groupNeedsExplicitBuildAssignment(group)) {
      console.log(
        `TestFlight group ${groupName} already has access to all builds; skipping assignment.`
      );
      continue;
    }
    const currentBuilds = await appStoreRequest(
      config,
      `/betaGroups/${group.id}/relationships/builds?limit=200`
    );
    if (currentBuilds.data.some((candidate) => candidate.id === build.id)) continue;
    await appStoreRequest(
      config,
      `/betaGroups/${group.id}/relationships/builds`,
      {
        method: "POST",
        body: JSON.stringify({
          data: [{ type: "builds", id: build.id }],
        }),
      }
    );
  }
}

async function submitBetaReview(config, build) {
  if (!config.submitForBetaReview) return;
  const current = await appStoreRequest(
    config,
    `/builds/${build.id}/betaAppReviewSubmission`,
    { allowNotFound: true }
  );
  if (current?.data?.id) {
    console.log(`Beta review submission already exists for build ${config.buildNumber}.`);
    return;
  }
  await appStoreRequest(config, "/betaAppReviewSubmissions", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "betaAppReviewSubmissions",
        relationships: {
          build: {
            data: { type: "builds", id: build.id },
          },
        },
      },
    }),
  });
}

export function buildReleaseManifest(config, serverEvidence, app, build, releasedAt) {
  if (
    serverEvidence?.version !== 2
    || serverEvidence.environment !== config.environment
    || serverEvidence.server?.repository !== config.repository
    || serverEvidence.server?.sha !== config.releaseSha
    || !Array.isArray(serverEvidence.services)
  ) {
    throw new Error("Server release evidence no longer matches the gated mobile release");
  }
  return {
    version: 1,
    environment: config.environment,
    mobile: {
      repository: config.repository,
      sha: config.releaseSha,
    },
    server: serverEvidence.server,
    services: serverEvidence.services,
    app: {
      bundleId: config.bundleId,
      appId: app.id,
      buildId: build.id,
      marketingVersion: config.marketingVersion,
      buildNumber: config.buildNumber,
      testflightGroups: config.groups,
      submittedForBetaReview: config.submitForBetaReview,
    },
    releasedAt,
  };
}

export async function main() {
  const config = parseReleaseConfig();
  await access(config.ipaPath, fsConstants.R_OK);
  const app = await findApp(config);
  const existingBuild = await uploadIfNeeded(config, app.id);
  const build = await waitForProcessedBuild(config, app.id, existingBuild);
  await setCompliance(config, build);
  await distributeToGroups(config, app.id, build);
  await submitBetaReview(config, build);

  const serverEvidence = JSON.parse(
    await readFile(config.serverEvidencePath, "utf8")
  );
  const manifest = buildReleaseManifest(
    config,
    serverEvidence,
    app,
    build,
    new Date().toISOString()
  );
  await writeFile(
    config.outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
