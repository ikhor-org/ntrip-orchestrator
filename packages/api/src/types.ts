export type OrgStatus = 'fixture' | 'pending_screening' | 'active' | 'suspended';
export type ScreeningStatus =
  | 'required'
  | 'pending'
  | 'cleared'
  | 'rejected'
  | 'fixture_exempt';

export interface Org {
  id: string;
  name: string;
  status: OrgStatus;
  screening_status: ScreeningStatus;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}
