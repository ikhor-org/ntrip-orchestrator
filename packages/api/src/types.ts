export type {
  Org,
  OrgStatus,
  ScreeningStatus,
  Device,
} from '@ntrip-orchestrator/core';

export interface ApiErrorBody {
  error: string;
  message: string;
}
