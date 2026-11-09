export type BleErrorCode =
  | "unsupported"
  | "cancelled"
  | "no_device"
  | "not_connected"
  | "timeout"
  | "disconnected"
  | "gatt"
  | "write_failed"
  | "invalid_package"
  | "busy"
  | "pairing_failed"
  | "invalid_settings"
  | "invalid_name"
  | "incompatible";

/** Errors surfaced by BLE clients. `cancelled` is recoverable and not shown as a failure. */
export class BleError extends Error {
  readonly code: BleErrorCode;
  constructor(code: BleErrorCode, message: string) {
    super(message);
    this.name = "BleError";
    this.code = code;
  }
}

export function isBleError(error: unknown): error is BleError {
  return error instanceof BleError;
}
