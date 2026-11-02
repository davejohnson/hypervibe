/** Cloud Run v2 ServiceScaling. Omitted protobuf scalars have native zero defaults. */
export function cloudRunInstanceBounds(scaling: unknown): { min: number; max: number } | undefined {
  if (scaling === undefined || scaling === null) return { min: 0, max: 0 };
  if (typeof scaling !== 'object' || Array.isArray(scaling)) throw new Error('Cloud Run service scaling is malformed.');
  const value = scaling as Record<string, unknown>;
  if (value.scalingMode === 'MANUAL') return undefined;
  if (value.scalingMode !== undefined && !['', 'SCALING_MODE_UNSPECIFIED', 'AUTOMATIC'].includes(value.scalingMode as string)) {
    throw new Error('Cloud Run service scaling mode is unknown.');
  }
  const min = value.minInstanceCount ?? 0;
  const max = value.maxInstanceCount ?? 0;
  if (typeof min !== 'number' || !Number.isSafeInteger(min) || min < 0
    || typeof max !== 'number' || !Number.isSafeInteger(max) || max < 0 || max !== 0 && min > max) {
    throw new Error('Cloud Run service instance bounds are malformed.');
  }
  return { min, max };
}

export function assertCloudRunInstanceBounds(scaling: unknown, expected: { min: number; max: number } | undefined): void {
  if (!expected) return;
  const actual = cloudRunInstanceBounds(scaling);
  if (!actual || actual.min !== expected.min || actual.max !== expected.max) {
    throw new Error('Cloud Run service instance bounds do not match the reviewed configuration.');
  }
}
