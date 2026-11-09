import type { LocationReport, TagDevice } from '../contracts';

export interface QuerySettings { rotationStart: number; rotationCount: number }
export type KeyMaterial =
  | { kind: 'fixed'; privateKey: string }
  | { kind: 'rotating'; masterPrivateKey: string; symmetricSeed: string };
export interface WorkspaceRecord {
  device: TagDevice;
  keys: KeyMaterial;
  query: QuerySettings;
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
