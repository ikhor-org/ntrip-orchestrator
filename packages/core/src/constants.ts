/** Seeded fixture org — non-prod only. */
export const FIXTURE_ORG_ID = '00000000-0000-4000-8000-000000000001';
export const FIXTURE_ORG_NAME = 'fixture-dev-org';

/** Forbidden keys in metering payloads (Sentinel soft constraint). */
export const METERING_FORBIDDEN_KEYS = [
  'lat',
  'lon',
  'latitude',
  'longitude',
  'gga',
  'nmea',
  'track',
  'position',
  'geofence',
  'last_position',
  'coords',
] as const;
