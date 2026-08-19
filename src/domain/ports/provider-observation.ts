export type Observation<T> =
  | { state: 'present'; value: T }
  | { state: 'absent' }
  | { state: 'unknown'; reason: string };
