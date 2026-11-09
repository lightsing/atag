/**
 * Minimal Web Bluetooth typings used by the setup client. TypeScript's DOM lib
 * does not ship them; kept module-local so they never clash with a future lib.
 */
export interface BtCharacteristic extends EventTarget {
  readonly value: DataView | null;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BtCharacteristic>;
  stopNotifications(): Promise<BtCharacteristic>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
}

export interface BtService {
  getCharacteristic(uuid: string): Promise<BtCharacteristic>;
}

export interface BtGattServer {
  readonly connected: boolean;
  connect(): Promise<BtGattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BtService>;
}

export interface BtDevice extends EventTarget {
  readonly id: string;
  readonly name?: string | null;
  readonly gatt?: BtGattServer;
}

export interface BtRequestOptions {
  filters: Array<{ services?: string[]; name?: string; namePrefix?: string }>;
  optionalServices?: string[];
}

export interface BtBluetooth {
  requestDevice(options: BtRequestOptions): Promise<BtDevice>;
}

export function getNavigatorBluetooth(): BtBluetooth | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { bluetooth?: BtBluetooth }).bluetooth;
}
