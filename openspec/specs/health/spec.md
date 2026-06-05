# health Specification

## Purpose
Liveness and deploy-verification endpoint. Exposes the running build's commit SHA
so CI can confirm a deployment is serving the expected commit.

## Requirements
### Requirement: Health endpoint
The system SHALL expose an HTTP GET `/api/health` endpoint that returns a JSON body
with a `status` field, a `commit` field, and an ISO-8601 `timestamp` field.

#### Scenario: Healthy response
- **WHEN** a client issues GET `/api/health`
- **THEN** the system responds with HTTP 200 and `status` equal to `ok`

#### Scenario: Build commit is reported
- **WHEN** the application was built with a known commit SHA
- **THEN** the `commit` field equals that build's SHA

#### Scenario: Unknown build commit
- **WHEN** the application was built without a known commit SHA
- **THEN** the `commit` field equals `unknown`
