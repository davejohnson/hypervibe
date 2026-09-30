// CI bootstrap registers only the declared-task provider and its evidence source.
// Application orchestration still resolves adapters through the provider registry.
import '../adapters/providers/railway/railway.adapter.js';
import '../adapters/providers/github/github.adapter.js';
