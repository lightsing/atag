import type { BleConnectionState, BleDeviceInfo, BleSessionSnapshot, DeviceCapabilities } from "../contracts";

export const TAG_CAPABILITIES: DeviceCapabilities = {
  provisioning: true, management: true, telemetry: true, ring: false, ota: false,
};

export function emptyBleSession(): BleSessionSnapshot {
  return {
    state: "disconnected", device: null, identity: null, deviceName: null,
    batteryMillivolts: null, telemetry: null, settings: null, encryption: "unknown",
    buttonCounter: null, lastButtonPressAt: null, connectedAt: null,
    estimatedConnectionDeadline: null, telemetryReceivedAt: null, busyOperation: null,
  };
}

export class BleSessionState {
  protected session = emptyBleSession();
  private readonly stateListeners = new Set<(state: BleConnectionState) => void>();
  private readonly sessionListeners = new Set<(session: BleSessionSnapshot) => void>();
  get state(): BleConnectionState { return this.session.state; }
  get deviceInfo(): BleDeviceInfo | null { return this.session.device ? { ...this.session.device } : null; }
  getSession(): BleSessionSnapshot { return structuredClone(this.session); }
  subscribe(listener: (state: BleConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  subscribeSession(listener: (snapshot: BleSessionSnapshot) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }
  protected update(patch: Partial<BleSessionSnapshot>): void {
    const oldState = this.session.state;
    this.session = { ...this.session, ...patch };
    if (this.state !== oldState) this.stateListeners.forEach(listener => listener(this.state));
    this.sessionListeners.forEach(listener => listener(this.getSession()));
  }
  protected clearListeners(): void { this.stateListeners.clear(); this.sessionListeners.clear(); }
}
