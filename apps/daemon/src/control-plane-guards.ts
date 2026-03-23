const SAFE_ID_RE = /^[A-Za-z0-9._:-]+$/;
const SAFE_MACHINE_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9._-]+$/;

export const MAX_CONTROL_COMMAND_CHARS = 4_000;
export const MAX_PATH_FIELD_CHARS = 1_024;
export const MAX_TASK_FIELD_CHARS = 4_096;
export const MAX_FILE_NAME_CHARS = 255;
export const MAX_REQUEST_ID_CHARS = 128;
export const VALID_SATELLITE_ACTIONS = new Set(["repair", "reinstall", "update"]);

export function isSafeWorkerId(value: string | undefined): boolean {
  return !!value && value.length <= 128 && SAFE_ID_RE.test(value);
}

export function isSafeMachineId(value: string | undefined): boolean {
  return !!value && value.length <= 64 && SAFE_MACHINE_RE.test(value);
}

export function isSafeModelId(value: string | undefined): boolean {
  return !!value && value.length <= 64 && SAFE_MODEL_RE.test(value);
}

export function isSafeRequestId(value: string | undefined): boolean {
  return !!value && value.length <= MAX_REQUEST_ID_CHARS && SAFE_ID_RE.test(value);
}

export function isSafePathField(value: string | undefined): boolean {
  return !!value && value.length <= MAX_PATH_FIELD_CHARS && !value.includes("\0");
}

export function isSafeTaskField(value: string | undefined): boolean {
  return !!value && value.length <= MAX_TASK_FIELD_CHARS && !value.includes("\0");
}

export function isSafeCommandField(value: string | undefined): boolean {
  return !!value && value.trim().length > 0 && value.length <= MAX_CONTROL_COMMAND_CHARS && !value.includes("\0");
}

export function isSafeFileName(value: string | undefined): boolean {
  return !!value && value.length <= MAX_FILE_NAME_CHARS && !value.includes("\0");
}

export function isValidQuadrant(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 1 && value <= 8);
}

export function isValidSatelliteAction(value: string | undefined): boolean {
  return value === undefined || VALID_SATELLITE_ACTIONS.has(value);
}
