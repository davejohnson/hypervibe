// CI bootstrap registers the task/evidence providers and selected object adapters.
// Application orchestration still resolves adapters through the provider registry.
import '../adapters/providers/railway/railway.adapter.js';
import '../adapters/providers/github/github.adapter.js';
import '../adapters/providers/aws/s3.adapter.js';
import '../adapters/providers/gcp/gcs.adapter.js';
import '../adapters/providers/azure/azure-blob.adapter.js';
