CREATE TABLE android_push_endpoint (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    endpoint_encrypted bytea NOT NULL,
    endpoint_hash bytea NOT NULL,
    app_variant text NOT NULL DEFAULT 'production',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'quarantined')),
    failure_count integer NOT NULL DEFAULT 0,
    last_success_at timestamptz,
    last_failure_at timestamptz,
    active_since timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days',
    disabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE android_push_preference (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    mentions boolean NOT NULL DEFAULT true,
    assignments boolean NOT NULL DEFAULT true,
    review_blockers boolean NOT NULL DEFAULT true,
    comments boolean NOT NULL DEFAULT false,
    routine_updates boolean NOT NULL DEFAULT false,
    enabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE android_push_delivery (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    endpoint_id uuid NOT NULL,
    inbox_item_id uuid,
    event_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    issue_id uuid,
    comment_id uuid,
    event_type text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'retry', 'sent', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    last_error_code text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);
