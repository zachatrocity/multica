ALTER TABLE android_push_endpoint
    DROP CONSTRAINT IF EXISTS android_push_endpoint_active_webpush_keys,
    DROP COLUMN IF EXISTS auth_encrypted,
    DROP COLUMN IF EXISTS p256dh_encrypted;
