import type { OtaPackage, OtaStatus } from "./ble/ota-protocol";
import type { OtaProgress, OtaReceipt, OtaVerification } from "./ble/ota-transfer";

/** Browser workspace models. The v1 local bridge only transports ciphertext. */
export type TagIcon = "keys" | "backpack" | "luggage" | "bike" | "tag";
export type AdvertisingMode = "fixed" | "rotating";
export type ErrorCode =
  | "AGENT_UNAVAILABLE" | "TIMEOUT" | "UNAUTHORIZED" | "AUTH_REQUIRED"
  | "AUTH_EXPIRED" | "NOT_FOUND" | "INVALID_REQUEST" | "VERSION_MISMATCH"
  | "CAPABILITY_UNSUPPORTED" | "UPSTREAM_UNAVAILABLE" | "INTERNAL_ERROR" | "CANCELLED";

export interface ClientFailure { code: ErrorCode; message: string; retryable: boolean }
export interface DeviceCapabilities {
  provisioning: boolean;
  management: boolean;
  telemetry: boolean;
  ring: boolean;
  ota: boolean;
}
export interface LocationReport {
  id: string;
  deviceId: string;
  observedAt: string;
  /** Rolling key round that decrypted this report, when recorded by the client. */
  rotation?: number;
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number;
  /** Battery voltage decoded from the current six-bit Offline Finding status. */
  batteryMillivolts: number;
  source: "findmy";
}
export interface TagDevice {
  id: string;
  name: string;
  icon: TagIcon;
  color: string;
  advertisingMode: AdvertisingMode;
  rotationIntervalMinutes: number | null;
  firmwareVersion: string | null;
  /** Immutable physical identity; a browser device id or display name is not this serial. */
  chipSerial?: string | null;
  /** Local profile lifecycle; creating keys does not configure a physical Tag. */
  provisioningState?: "draft" | "confirmed";
  capabilities: DeviceCapabilities;
  latestReport: LocationReport | null;
  createdAt: string;
}
export interface AuthState {
  status: "not_configured" | "ready" | "expired";
  accountLabel: string | null;
}
export interface DeviceMetadataPatch { name?: string; icon?: TagIcon; color?: string }
export interface ReportQuery { from: string; to: string; cursor?: string; limit?: number }
export interface ReportPage { reports: LocationReport[]; nextCursor: string | null }
export interface WorkspaceOperation {
  id: string;
  deviceId: string;
  kind: "refresh_reports";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  result: { newReportCount: number } | null;
  error: ClientFailure | null;
}
export interface ProvisioningBundleRequest {
  name: string;
  mode: AdvertisingMode;
  rotationIntervalMinutes?: number;
}
export interface ProvisioningBundle {
  deviceId: string;
  mode: AdvertisingMode;
  rotationIntervalMinutes: number | null;
  /** Transient, sensitive. Never persist or log the rolling seed in this payload. */
  configurationBase64: string;
}
export interface WorkspaceClient {
  getAuthState(signal?: AbortSignal): Promise<AuthState>;
  listDevices(signal?: AbortSignal): Promise<TagDevice[]>;
  getDevice(id: string, signal?: AbortSignal): Promise<TagDevice>;
  updateDevice(id: string, patch: DeviceMetadataPatch, signal?: AbortSignal): Promise<TagDevice>;
  deleteDevice(id: string, signal?: AbortSignal): Promise<void>;
  listReports(id: string, query: ReportQuery, signal?: AbortSignal): Promise<ReportPage>;
  refreshReports(id: string, signal?: AbortSignal): Promise<WorkspaceOperation>;
  getOperation(id: string, signal?: AbortSignal): Promise<WorkspaceOperation>;
  createProvisioningBundle(input: ProvisioningBundleRequest, signal?: AbortSignal): Promise<ProvisioningBundle>;
}

export type BleConnectionState = "disconnected" | "selecting" | "connecting" | "connected" | "pairing" | "writing";
export interface BleAvailability { supported: boolean; secureContext: boolean; reason?: string }
export interface BleDeviceInfo { id: string; name: string }
export interface ProvisioningStatus {
  protocolVersion: number;
  state: "setup" | "accepted" | "rejected";
  errorCode: number;
  mode: AdvertisingMode | null;
  expectedLength: number;
  resultCode: number;
  operation: "idle" | "keys" | "name" | "settings" | "led";
  /** Only key/name/settings results 1/3/5 confirm Flash; LED 7/8 are transient. */
  commitConfirmed: boolean;
}
export type TagKeyMode = AdvertisingMode | "unset";
export interface BleIdentity {
  manufacturer: string;
  model: string;
  firmwareVersion: string;
  /** Browsers block standard 2a25. Null until encrypted v1 telemetry supplies it. */
  serial: string | null;
}
export interface BleTelemetry {
  version: 1;
  keyMode: TagKeyMode;
  phase: "idle" | "broadcasting" | "advertising" | "connected";
  batteryMillivolts: number;
  supplyMillivolts: number;
  uptimeSeconds: number;
  rotation: number;
  rotationIntervalSeconds: number;
  resetReason: number;
  chipSerial: string;
  advertisingSecondsLeft: number;
  connectionSecondsLeft: number;
  batteryLowMillivolts: number;
  batteryRecoveryMillivolts: number;
  flags: { buttonHeld: boolean; lowVoltage: boolean; encrypted: boolean; resetPin: boolean; externalClock: boolean; dcdc: boolean; hasLed: boolean; ledEnabled: boolean };
}
/** Field names intentionally match the firmware/host JSON settings codec. */
export interface TagSettings {
  led_enabled: boolean;
  advertising_interval_ms: number;
  gatt_interval_ms: number;
  tx_power_dbm: number;
  rotation_minutes: number;
  gatt_advertising_seconds: number;
  connection_seconds: number;
  battery_idle_seconds: number;
  battery_gatt_seconds: number;
  reset_hold_seconds: number;
  battery_low_mv: number;
  battery_recovery_mv: number;
  battery_calibration_ppm: number;
}
export interface BleSessionSnapshot {
  state: BleConnectionState;
  device: BleDeviceInfo | null;
  identity: BleIdentity | null;
  deviceName: string | null;
  batteryMillivolts: number | null;
  telemetry: BleTelemetry | null;
  settings: TagSettings | null;
  encryption: "unknown" | "unencrypted" | "pairing" | "encrypted";
  buttonCounter: number | null;
  lastButtonPressAt: string | null;
  connectedAt: string | null;
  /** Estimate until protected telemetry provides the authoritative remaining time. */
  estimatedConnectionDeadline: string | null;
  telemetryReceivedAt: string | null;
  otaStatus: OtaStatus | null;
  busyOperation: "pairing" | "configure" | "rename" | "settings" | "reboot" | "factory_reset" | "led" | "ota" | null;
}
export interface BleClient {
  readonly state: BleConnectionState;
  readonly deviceInfo: BleDeviceInfo | null;
  getAvailability(): BleAvailability;
  /** Call directly from a user gesture; do not await other work before the picker. */
  requestDevice(): Promise<BleDeviceInfo>;
  connect(): Promise<ProvisioningStatus>;
  disconnect(): void;
  dispose(): void;
  getSession(): BleSessionSnapshot;
  subscribeSession(listener: (snapshot: BleSessionSnapshot) => void): () => void;
  getCapabilities(): DeviceCapabilities;
  readIdentity(): Promise<BleIdentity>;
  readBattery(): Promise<number>;
  ensureEncrypted(): Promise<void>;
  readTelemetry(): Promise<BleTelemetry>;
  readName(): Promise<string>;
  readSettings(): Promise<TagSettings>;
  writeName(name: string): Promise<ProvisioningStatus>;
  writeSettings(settings: TagSettings): Promise<ProvisioningStatus>;
  /** A successful ATT command send is not durable reboot/reset confirmation. */
  reboot(): Promise<void>;
  factoryReset(): Promise<void>;
  /** Requires an encrypted link; LED receipts never confirm a Flash save. */
  identifyLed?(active: boolean): Promise<ProvisioningStatus>;
  applyConfiguration(bytes: Uint8Array): Promise<ProvisioningStatus>;
  uploadFirmware(update: OtaPackage, onProgress: (progress: OtaProgress) => void, signal?: AbortSignal): Promise<OtaReceipt>;
  verifyFirmware(receipt: OtaReceipt): Promise<OtaVerification>;
  subscribe(listener: (state: BleConnectionState) => void): () => void;
}
