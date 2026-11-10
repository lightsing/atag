import type { LocationReport, TagDevice } from '../contracts';

export interface QueryWindow { rotationStart: number; rotationCount: number }
export interface QuerySettings extends QueryWindow { rotationMode?: 'auto' | 'manual' }
export interface RotationTiming {
  rotation: number;
  observedAt: string;
  intervalMinutes: number;
}
export type KeyMaterial =
  | { kind: 'fixed'; privateKey: string }
  | { kind: 'rotating'; masterPrivateKey: string; symmetricSeed: string };
export interface WorkspaceRecord {
  device: TagDevice;
  keys: KeyMaterial;
  query: QuerySettings;
  /** Most recent reading of the running Tag, separate from its configuration package. */
  rotationTiming?: RotationTiming;
  reports: LocationReport[];
  provisioning: 'draft' | 'confirmed';
}
export interface QueryAccount {
  dsid: string; searchPartyToken: string; uid: string; deviceId: string; accountLabel: string | null;
}
export interface WorkspaceData {
  version: 1;
  records: WorkspaceRecord[];
  account: QueryAccount | null;
  accountExpired?: boolean;
  anisetteUrl: string;
}
export interface WorkspaceStats { deviceCount: number; reportCount: number; hasAccount: boolean }
export interface BackupSummary extends WorkspaceStats { createdAt: string }
export const emptyWorkspace = (): WorkspaceData => ({ version: 1, records: [], account: null, anisetteUrl: '' });
