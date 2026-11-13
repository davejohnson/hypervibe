import type { EngineProviderRequirement } from '../../../domain/ports/infrastructure-engine.port.js';
import { gcpEngineBackend } from '../../providers/gcp/tofu/gcp-engine.backend.js';

/**
 * Produced by managed OpenTofu 1.13.9 `providers lock` for darwin_arm64,
 * darwin_amd64, linux_arm64, linux_amd64. All archives were signature-verified
 * by OpenTofu against upstream release checksums. Never resolve latest at runtime.
 * Google reuses the reviewed engine integration pin and lock checksums.
 */
export const DNS_PROVIDER_REQUIREMENTS: Record<string, EngineProviderRequirement> = {
  "cloudflare": {
    "source": "cloudflare/cloudflare",
    "version": "5.19.1",
    "lockHashes": [
      "h1:HkKPMZ/n+QiExkRUSLjGMTGnuIaph+k932LiTp7CKZM=",
      "h1:LicdZu3hugYpWuCAprg2EslbVP0zANnV9n9/2KiOnYc=",
      "h1:VvnqJUTXlbKrB/6X2K9dc7lE3CQj3KX055gr+bMyXsg=",
      "h1:XYVRvCG+auhkY1NnSe6pK7ClqKW5GX8BgUnMQwfC7mQ=",
      "h1:Xf1PHfUfK690caJYZvoudKKBppfleJ6RcqsEQWqKVCw=",
      "h1:i6pbudcLi1X2MVeN9IV3bDeiGWnWhn+v9dMrMzAN+l8=",
      "h1:mopYISyLkUVUwMjJbuPenxIUVDrna1/7ACB1hfMfciU=",
      "h1:xfoTAyKkR12F8nuVC96DwBA2Fva38o5BnYHLXZzmDP4=",
      "zh:0651618000db705564dab5a25322b9d76ea54b7dd78931ed3565497b559babeb",
      "zh:1a7847e9479fb6d21a65ef933ffae1416b1e4b44ca940c0d6c50fc4248cc4a0d",
      "zh:5597cee5854131045eb9f201ae3a70b59c51955d31a647d9616863c746d902cb",
      "zh:580786830d93e35b957754fd4c62d4681a3b19abc28b757e41acba26455663b1",
      "zh:83c4bdfb0e74fd50e56fff3c461d76c1c1ec61af3f679e4de1aa70b5ed05a09f",
      "zh:abb4d1052cee61d80f9cb51e5421e3c118312403afb7104b98bd7e310ac736ee",
      "zh:b0aeeb3d66ea4d719989875e778c477065ba941e3a76e9a8caacc3be08208dd9",
      "zh:e43b4b2dfcec1ce2115f5a5c86042d432deb49bee8eae103eb56d97ea02e2e3b",
      "zh:f809ab383cca0a5f83072981c64208cbd7fa67e986a86ee02dd2c82333221e32"
    ]
  },
  "aws": {
    "source": "hashicorp/aws",
    "version": "6.40.0",
    "lockHashes": [
      "h1:7BnIMXbqx8KNZB4lCrqe0bkRvFXDI/fQ8LV0CxpfMAY=",
      "h1:8/qAJME5G5QBK8Dt/53KfJZv11VYv6d4UarIIKwuTHI=",
      "h1:8TiJXau7HHOt4S1cDSZjstrnqYNsPCquntY0PsKS8xg=",
      "h1:9CzXEeN/K/RztuBBUWeGqHsE0xo88y/ivZBfKOFhXEM=",
      "h1:BQDQqkoJhGYF1gvHDaHODOg0L5AVL/W+/uU8Sao237o=",
      "h1:KEnGiB4OdqbKURctTxrkmV3SttkYCuG148v3qwn639s=",
      "h1:Rpsh543knmB+/8SSt12/E7eNCrhorTyTsE9hQ3X2/t4=",
      "h1:VzDjiVhPpwl3DByxsmVJdFBSiYX0t37gHwiV1jpC4dM=",
      "h1:WDCDIIeDlPubCYrjPGKuZhi+qtXl2whjDV7c1vqwiU4=",
      "h1:hExw5wgTTJqjX9wGzzlFQBy9mo7hIAU7Q8UDJCwTciM=",
      "h1:hQsY0wzBdY01lqMPcPFynsh5r9r3ZnnU0ZmYoqXPHm4=",
      "h1:izHACzJEz0zR8c20ud0v004qgnbEnNB5y9b7YF/UC+k=",
      "h1:k93ncx2fEvEZbwZiNNK+9RKUk4IySiwmj0v26aE+u3c=",
      "h1:txnr6WmBWZ0vC3EFg5bQCAK6tLigjPLtai/9tpxO1t0=",
      "h1:uI0VJoiZ7nSJu0GnK7kJoEvx8t8/sBUpYH7kp8pYmO0=",
      "zh:0afa48ff254e87987ab58656c0c9ce408c223df084ca3aa73170eb264c7ffdd8",
      "zh:1cac5867dde6803c251b2eecfdce870a2f19cb04e09ad28b6d895d3faf8fd853",
      "zh:2e6c6267dda9a12c6945bbafd4405af6238c3d2617736a2fe6a129ea82b05b81",
      "zh:38ad3eefbf5a0544b049fcdadec9a1d9cf56f18c9c0cd03659133d635a8e0042",
      "zh:462a69e653529aff033b22e41332c6b170dfbcd2dac357e0ae40dc84d809a964",
      "zh:5007c5d67ccd5ef271eb9f512e71a0ef55dae23b6099eec1762a06995d62d4b0",
      "zh:51778e221c1bf898c5c93acaba0f42dc6b0df14d0982db97d52615061874cae3",
      "zh:711de3f42d0b26efb5332989e20135079c9a09ee39a5d7e0a2c0e73541991133",
      "zh:8596ca6540cb2b5bce0de8ad89f030c8ef8088f1128c438f9c362b0657dc89af",
      "zh:923a632c0995dbcc2cf8678e1e418cc4f3c57a6b3aa0b4cee719b91e7296ef8d",
      "zh:9839e87b4c3f0112750eeb387f1ec9a982200b67184ccd9482be4b577e1e48f6",
      "zh:9d994cbaa6a03d78274fd32d4a00b9c97ad202605f11973d738737f20995746c",
      "zh:a73c5687001b7a79b3cbbcf4a6d4b162cb3a0b73ed322382615b77d3f392f880",
      "zh:a86a021475165ff3bed8172d846e932cbc047169bb6ee42ce28b41301a7e3988",
      "zh:c200c757634fb83456e21006281d663c71415845450c5448b9598698aa780e7c"
    ]
  },
  "azurerm": {
    "source": "hashicorp/azurerm",
    "version": "4.65.0",
    "lockHashes": [
      "h1:6370YV4YIXj8VVVQGOfnelXZlg68bP1DtENxcVBcteo=",
      "h1:6FDMkWkgo83HH0HBfaliocXaqvkI22we4Yd/B099gag=",
      "h1:Al6yYsLdLlV5u4ZpXSuVYVJ+MAzukJvucj7nGg2vqv8=",
      "h1:EGMNnEGA1uJM666Ym0iJI9RdnpVCSoOY+hldePp5k5A=",
      "h1:EKrzRvON7M3npOJUw2C7JeQMXAstX+GlDYvidMggaiE=",
      "h1:Eg0sA/4KO/aTuR/arpmpVDOlPpAAh9cqRETBqWt3EMQ=",
      "h1:Se49RFXdccjDLhq5+P+pJB5fLRs9cbtDjz0pKxn5/rM=",
      "h1:dQuO7PISuyyjI5DSz0a6pAOSSDzA7tit/pifTKRoxCs=",
      "h1:m+CL1sSQ4sDCFQOd9d5Wg3H9IM+traQy1DX/Ub9jetI=",
      "h1:nUQCOkIiIoJ3eUCBcz9Z5LLJFV7Wn7dTuqd4zwXGNv4=",
      "h1:reE8DBQR8rRsE8dRy6u9XGfNlgdcXSnyeCMz2Xc49Sw=",
      "h1:uwkMQWCYe1zuD5Aa5r20k8OodzI790+sTiDvvSNSjcE=",
      "h1:whUD++x0P++Ubnf6q/ErHzSpUyYE37xE+Woxckttb+U=",
      "h1:yv2Pedsoy2mPdBjwhkkB5KMixbkXkqQpdpPKqZvyLvw=",
      "h1:zaHtm4FQofX9Y8sxvBvjfcSmWrzQfICAelHKLlnOzX0=",
      "zh:14ec9333dba5fe5e72f5e6be8609d8c94e1823cd52ab0343fd511a758de7dae3",
      "zh:2520f8d6987b76276275960ed69b3b1f4145c8f6355462e678f9e53ec454d71b",
      "zh:390ef2c87c3006c4c590f6d9503dc7ad1512406b9e3c9a588ff5f0b5a70b1a52",
      "zh:423569fac57c010387f9162eb8068651be218d48161418310358e7303206cf42",
      "zh:48462611f6085d05e98d299f65aa956ff1ab6cdd6165b1f30146784310fd480a",
      "zh:63d8d6e99384ecd75c608d832784cd833987e9b651b2bdd79e866baef2deed49",
      "zh:642d384514c597fab8d652659034cac8a81e661d6cd844c4e4b4c554f93104dd",
      "zh:649a79522ea1e37b5ede825a3142c9f16af794839ff76d1abd788ba1f879806c",
      "zh:6deb4ace1549561ab0da1a8a14b6171d7cfcda2c3ea759dfcb5ed62e33a9dd8d",
      "zh:769a3c83a3019c3638b46630d9dedc0dbca3d7d6bc88b10befd0149c57cbee4e",
      "zh:95c748f48b40f57c529b82dfd6f2e5d2aab7c2e5a93fafeddc60856b18b15ca5",
      "zh:c81e8e12736b47bf03faf8cc1a1aaabd7b110542f77253672859e8bc081780ff",
      "zh:d011013c5334f347aa313f4456407cdef4dd81efca5f5b4742b0b221e0dbedb8",
      "zh:d8d4f3559f738ee6e6c18c9011010986690cdfe26d9c952d5626a0f341314591",
      "zh:dfe976d28dbe6c6687f2e000d6039dd0d75abf302e2b698519a5503a3c90dc86"
    ]
  }
};
DNS_PROVIDER_REQUIREMENTS.google = gcpEngineBackend.providerRequirements.google!;
