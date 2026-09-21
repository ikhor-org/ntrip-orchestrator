# Runbook — rotate / revoke credentials

| Field | Value |
| --- | --- |
| **Milestone** | M3 |
| **Date** | 21 Sep 2026 (Europe/Oslo) |
| **Audience** | Ops / org admin |

## Org API keys

1. **Inventory** — `GET /v0/orgs/{org_id}/api-keys` (ops key or org `admin`).
2. **Issue replacement** — `POST /v0/orgs/{org_id}/api-keys` with `role` = `admin` | `operator` | `read`. Plaintext returned **once**.
3. **Distribute** — out-of-band to the operator; never log or commit plaintext.
4. **Revoke old** — `POST /v0/orgs/{org_id}/api-keys/{key_id}/revoke`.
5. **Verify** — old key gets `401`; new key works; audit shows revoke.

## Device pseudo-credentials

1. Provision a replacement device (or re-provision path when available).
2. Update field NTRIP client config with new pseudo-username/password.
3. Confirm old sessions fail auth; new sessions connect.
4. Prefer revoke/disable of old device credential via device revoke when exposed.

## Vault upstream secrets

1. Rotate upstream password/token at the provider.
2. Re-seed / update vault secret via fixture/admin vault path (pilot: ops-assisted).
3. Confirm failover/health still green; audit vault mutation.

## Roles reminder

| Role | Mutating devices/profiles | API key admin | Screening / activate |
| --- | --- | --- | --- |
| `read` | no | no | no |
| `operator` | yes | no | no |
| `admin` | yes | yes | no (ops key) |
| Ops (`X-Ops-Key`) | yes | yes | yes |
