ALTER TABLE android_push_delivery
    ADD COLUMN actor_type text,
    ADD COLUMN actor_id uuid,
    ADD COLUMN event_category text NOT NULL DEFAULT '',
    ADD COLUMN event_title text NOT NULL DEFAULT '',
    ADD COLUMN event_body text NOT NULL DEFAULT '',
    ADD COLUMN event_details jsonb NOT NULL DEFAULT '{}'::jsonb;
