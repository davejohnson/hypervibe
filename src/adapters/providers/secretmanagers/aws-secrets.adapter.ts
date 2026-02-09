import {
  type ISecretManagerAdapter,
  type SecretManagerCapabilities,
  type SecretManagerVerifyResult,
  type ResolvedSecret,
  type SecretReference,
  type SecretListItem,
  type SecretReceipt,
  type RotationResult,
  type AwsSecretsCredentials,
  AwsSecretsCredentialsSchema,
} from '../../../domain/ports/secretmanager.port.js';
import { secretManagerRegistry } from '../../../domain/registry/secretmanager.registry.js';

// AWS Signature V4 signing helper
async function signRequest(
  method: string,
  url: URL,
  body: string,
  credentials: AwsSecretsCredentials,
  service: string
): Promise<Record<string, string>> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = credentials.region || 'us-east-1';

  // Create canonical request
  const host = url.host;
  const canonicalUri = url.pathname;
  const canonicalQuerystring = '';
  const payloadHash = await sha256(body);

  const canonicalHeaders = [
    `content-type:application/x-amz-json-1.1`,
    `host:${host}`,
    `x-amz-date:${amzDate}`,
  ].join('\n') + '\n';

  const signedHeaders = 'content-type;host;x-amz-date';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join('\n');

  // Calculate signature
  const kDate = await hmacSha256(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256Bytes(kDate, region);
  const kService = await hmacSha256Bytes(kRegion, service);
  const kSigning = await hmacSha256Bytes(kService, 'aws4_request');
  const signature = await hmacSha256Hex(kSigning, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Date': amzDate,
    'Authorization': authorizationHeader,
  };
}

async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(key: string, message: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacSha256Bytes(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const encoder = new TextEncoder();
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

async function hmacSha256Hex(key: ArrayBuffer, message: string): Promise<string> {
  const result = await hmacSha256Bytes(key, message);
  return Array.from(new Uint8Array(result))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface AwsSecretValue {
  ARN: string;
  Name: string;
  VersionId: string;
  SecretString?: string;
  SecretBinary?: string;
  VersionStages: string[];
  CreatedDate: number;
}

interface AwsSecretList {
  SecretList: Array<{
    ARN: string;
    Name: string;
    LastChangedDate?: number;
    LastAccessedDate?: number;
    Tags?: Array<{ Key: string; Value: string }>;
  }>;
  NextToken?: string;
}

export class AwsSecretsAdapter implements ISecretManagerAdapter {
  readonly name = 'aws-secrets' as const;

  readonly capabilities: SecretManagerCapabilities = {
    supportsVersioning: true,
    supportsMultipleKeys: true, // Via JSON in SecretString
    supportsRotation: true,
    supportsAuditLog: false, // Via CloudTrail, not accessible here
    supportsDynamicSecrets: false,
    maxSecretSize: 64 * 1024, // 64KB
  };

  private credentials: AwsSecretsCredentials | null = null;

  async connect(credentials: unknown): Promise<void> {
    this.credentials = credentials as AwsSecretsCredentials;

    // If no explicit credentials, check environment
    if (!this.credentials.accessKeyId) {
      this.credentials.accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      this.credentials.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    }

    if (!this.credentials.accessKeyId || !this.credentials.secretAccessKey) {
      throw new Error('AWS credentials required (accessKeyId + secretAccessKey or AWS_ACCESS_KEY_ID env vars)');
    }
  }

  async verify(): Promise<SecretManagerVerifyResult> {
    try {
      // Try to list secrets with max 1 result to verify credentials
      await this.request('ListSecrets', { MaxResults: 1 });
      return {
        success: true,
        identity: `AWS (${this.credentials?.region || 'us-east-1'})`,
        capabilities: this.capabilities,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getSecret(path: string, key?: string, version?: string): Promise<ResolvedSecret> {
    const params: Record<string, unknown> = { SecretId: path };
    if (version) {
      params.VersionId = version;
    }

    const response = await this.request<AwsSecretValue>('GetSecretValue', params);

    let value: string;
    let secretData: Record<string, string> | null = null;

    if (response.SecretString) {
      // Try to parse as JSON
      try {
        secretData = JSON.parse(response.SecretString);
      } catch {
        // Not JSON, use as-is
        value = response.SecretString;
      }

      if (secretData) {
        if (key) {
          if (!(key in secretData)) {
            throw new Error(`Key '${key}' not found in secret at ${path}`);
          }
          value = secretData[key];
        } else {
          // Single key = return value, multiple = return JSON
          const keys = Object.keys(secretData);
          if (keys.length === 1) {
            value = secretData[keys[0]];
          } else {
            value = response.SecretString;
          }
        }
      }
    } else if (response.SecretBinary) {
      value = Buffer.from(response.SecretBinary, 'base64').toString('utf-8');
    } else {
      throw new Error(`Secret ${path} has no value`);
    }

    return {
      value: value!,
      version: response.VersionId,
      createdAt: new Date(response.CreatedDate * 1000),
      metadata: secretData ? { keys: Object.keys(secretData).join(',') } : undefined,
    };
  }

  async getSecrets(references: SecretReference[]): Promise<Map<string, ResolvedSecret>> {
    const results = new Map<string, ResolvedSecret>();

    // AWS Secrets Manager has BatchGetSecretValue but it's relatively new
    // For broader compatibility, we fetch in parallel
    const promises = references.map(async (ref) => {
      try {
        const secret = await this.getSecret(ref.path, ref.key, ref.version);
        results.set(ref.raw, secret);
      } catch (error) {
        results.set(ref.raw, {
          value: '',
          metadata: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });

    await Promise.all(promises);
    return results;
  }

  async setSecret(path: string, values: Record<string, string>): Promise<SecretReceipt> {
    try {
      // Check if secret exists
      let exists = false;
      try {
        await this.request('DescribeSecret', { SecretId: path });
        exists = true;
      } catch {
        // Secret doesn't exist
      }

      const secretString = JSON.stringify(values);

      if (exists) {
        const response = await this.request<{ ARN: string; VersionId: string }>(
          'PutSecretValue',
          { SecretId: path, SecretString: secretString }
        );
        return {
          success: true,
          path,
          version: response.VersionId,
        };
      } else {
        const response = await this.request<{ ARN: string; VersionId: string }>(
          'CreateSecret',
          { Name: path, SecretString: secretString }
        );
        return {
          success: true,
          path,
          version: response.VersionId,
        };
      }
    } catch (error) {
      return {
        success: false,
        path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deleteSecret(path: string): Promise<SecretReceipt> {
    try {
      await this.request('DeleteSecret', {
        SecretId: path,
        ForceDeleteWithoutRecovery: false, // 30-day recovery window
      });
      return { success: true, path };
    } catch (error) {
      return {
        success: false,
        path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listSecrets(pathPrefix?: string): Promise<SecretListItem[]> {
    const secrets: SecretListItem[] = [];
    let nextToken: string | undefined;

    do {
      const params: Record<string, unknown> = { MaxResults: 100 };
      if (nextToken) {
        params.NextToken = nextToken;
      }
      if (pathPrefix) {
        params.Filters = [{ Key: 'name', Values: [pathPrefix] }];
      }

      const response = await this.request<AwsSecretList>('ListSecrets', params);

      for (const secret of response.SecretList) {
        secrets.push({
          path: secret.Name,
          updatedAt: secret.LastChangedDate
            ? new Date(secret.LastChangedDate * 1000)
            : undefined,
        });
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return secrets;
  }

  async rotateSecret(path: string): Promise<RotationResult> {
    try {
      const response = await this.request<{ ARN: string; VersionId: string }>(
        'RotateSecret',
        { SecretId: path }
      );

      return {
        success: true,
        path,
        newVersion: response.VersionId,
        rotatedAt: new Date(),
      };
    } catch (error) {
      return {
        success: false,
        path,
        rotatedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.credentials || !this.credentials.accessKeyId) {
      throw new Error('Not connected. Call connect() first.');
    }

    const region = this.credentials.region || 'us-east-1';
    const url = new URL(`https://secretsmanager.${region}.amazonaws.com/`);
    const body = JSON.stringify(params);

    const headers = await signRequest('POST', url, body, this.credentials, 'secretsmanager');
    headers['X-Amz-Target'] = `secretsmanager.${action}`;

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body,
    });

    const responseText = await response.text();

    if (!response.ok) {
      let errorMessage = `AWS Secrets Manager error: ${response.status}`;
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.message || errorJson.Message) {
          errorMessage = errorJson.message || errorJson.Message;
        }
      } catch {
        if (responseText) {
          errorMessage = responseText;
        }
      }
      throw new Error(errorMessage);
    }

    return JSON.parse(responseText) as T;
  }
}

// Self-register with secret manager registry
secretManagerRegistry.register({
  metadata: {
    name: 'aws-secrets',
    displayName: 'AWS Secrets Manager',
    credentialsSchema: AwsSecretsCredentialsSchema,
    setupHelpUrl: 'https://docs.aws.amazon.com/secretsmanager/',
  },
  factory: (credentials) => {
    const adapter = new AwsSecretsAdapter();
    return adapter;
  },
  defaultCapabilities: {
    supportsVersioning: true,
    supportsMultipleKeys: true,
    supportsRotation: true,
    supportsAuditLog: false,
    supportsDynamicSecrets: false,
    maxSecretSize: 64 * 1024,
  },
});
