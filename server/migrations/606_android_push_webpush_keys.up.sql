ALTER TABLE android_push_endpoint
    ADD COLUMN p256dh_encrypted bytea,
    ADD COLUMN auth_encrypted bytea;

UPDATE android_push_endpoint
SET status = 'quarantined',
    disabled_at = now(),
    updated_at = now()
WHERE status = 'active';

ALTER TABLE android_push_endpoint
    ADD CONSTRAINT android_push_endpoint_active_webpush_keys
    CHECK (
        status <> 'active'
        OR (p256dh_encrypted IS NOT NULL AND auth_encrypted IS NOT NULL)
    );
