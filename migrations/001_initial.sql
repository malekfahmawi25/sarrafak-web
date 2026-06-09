CREATE TABLE clients (
    id UUID PRIMARY KEY,
    account_number VARCHAR(32) NOT NULL UNIQUE
        CHECK (account_number ~ '^[0-9]{4,32}$'),
    pin_hash TEXT NOT NULL,
    name VARCHAR(160) NOT NULL
        CHECK (char_length(name) BETWEEN 2 AND 160),
    phone VARCHAR(32) NOT NULL
        CHECK (char_length(phone) BETWEEN 7 AND 32),
    balance_cents BIGINT NOT NULL DEFAULT 0
        CHECK (balance_cents BETWEEN 0 AND 9007199254740991),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    type VARCHAR(16) NOT NULL CHECK (type IN ('deposit', 'withdraw')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    balance_after_cents BIGINT CHECK (balance_after_cents >= 0),
    idempotency_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, idempotency_key)
);

CREATE INDEX transactions_client_created_idx
    ON transactions (client_id, created_at DESC);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY CHECK (char_length(token_hash) = 64),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_client_idx ON sessions (client_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE login_throttles (
    key_hash TEXT PRIMARY KEY CHECK (char_length(key_hash) = 64),
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    blocked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX login_throttles_expiry_idx ON login_throttles (blocked_until);

CREATE TABLE audit_events (
    id UUID PRIMARY KEY,
    client_id UUID REFERENCES clients(id) ON DELETE RESTRICT,
    event_type VARCHAR(64) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_events_client_created_idx
    ON audit_events (client_id, created_at DESC);

CREATE FUNCTION prevent_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
