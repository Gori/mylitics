# Credential Encryption Architecture

## Current State

Platform credentials (Stripe API keys, Google service account JSON, Apple private keys) are currently stored as plain JSON strings in the `platformConnections.credentials` field.

## Recommended Approach

### Option 1: Client-Side Encryption (Recommended)

Encrypt credentials before they reach the Convex backend using a user-derived key.

**Implementation:**
1. Generate a key encryption key (KEK) from the user's session
2. Use Web Crypto API to encrypt credentials in the browser
3. Store only encrypted blobs in Convex
4. Decrypt on the client when needed for sync operations

**Pros:**
- Credentials never exist in plain text on the server
- Even database compromise doesn't expose credentials

**Cons:**
- Key management complexity
- Can't decrypt server-side without key exchange

### Option 2: Convex Environment Variables

Store the most sensitive credentials (like master encryption keys) in Convex environment variables, and use those to encrypt/decrypt stored credentials.

**Implementation:**
1. Set `ENCRYPTION_KEY` as a Convex environment variable
2. Use a Node.js action to encrypt credentials before storage
3. Decrypt in actions when accessing platform APIs

**Pros:**
- Simpler implementation
- Server-side decryption possible

**Cons:**
- Encryption key still accessible to code

### Option 3: External Secrets Manager

Use a service like AWS Secrets Manager, HashiCorp Vault, or Doppler.

**Implementation:**
1. Store credential references in Convex
2. Fetch actual credentials from secrets manager at runtime
3. Cache in memory during sync operations

**Pros:**
- Industry-standard security
- Audit logging
- Automatic rotation support

**Cons:**
- Additional service dependency
- Added latency

## Immediate Mitigation

Until full encryption is implemented:

1. Ensure Convex dashboard access is restricted
2. Use short-lived API keys where possible (Stripe supports this)
3. Apply principle of least privilege to API keys
4. Regular key rotation

## Implementation Priority

1. **Phase 1**: Add warning in UI when storing credentials
2. **Phase 2**: Implement Option 2 (Convex env var encryption)
3. **Phase 3**: Consider Option 3 for enterprise deployments
