CREATE TABLE mobile_push_subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('expo', 'unifiedpush')),
  token TEXT NOT NULL,
  device_name TEXT,
  app_variant TEXT NOT NULL DEFAULT 'production',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  failure_count INTEGER NOT NULL DEFAULT 0,
  disabled_at TIMESTAMPTZ,
  UNIQUE (user_id, provider, token)
);

CREATE INDEX mobile_push_subscription_user_active_idx
  ON mobile_push_subscription (user_id)
  WHERE disabled_at IS NULL;
