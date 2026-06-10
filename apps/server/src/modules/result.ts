export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; message?: string; code?: string };

export function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(
  error: string,
  details: { message?: string; code?: string } = {},
): ServiceResult<T> {
  return { ok: false, error, ...details };
}
