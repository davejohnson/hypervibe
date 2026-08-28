/**
 * Side-effect-free server integration surface. Import this subpath from a
 * trusted host process; the package root remains the Hypervibe CLI entrypoint.
 */
export {
  COMMITTED_SPEC_PATH,
  MAX_COMMITTED_SPEC_BYTES,
  CommittedSpecInspectionError,
  inspectCommittedProjectSpecV1,
  type CommittedSpecInspectionErrorCode,
  type CommittedSpecInspectionInputV1,
  type CommittedSpecInspectionReceiptV1,
  type DeclaredProviderCapabilityV1,
} from './application/hosted/committed-spec-inspection.js';
