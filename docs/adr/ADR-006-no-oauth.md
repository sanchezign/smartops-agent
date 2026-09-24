# ADR-006: No OAuth — JWT only for the admin panel

Date: 2026-09-24
Status: accepted

## Decision

The admin panel uses JWT access + refresh tokens with roles `admin` and
`operator`. No OAuth/social login (Google, GitHub).

## Reason

The panel is an internal tool for a small, known team of operators; there are no
public end users. Social login would add provider setup and attack surface
without benefit.

## Consequences

- Users are created by an admin (seed/panel); password hashing and refresh-token
  rotation are implemented in phase 8.
- If a client requires SSO later, it is added through a new ADR.
