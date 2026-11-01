CREATE INDEX CONCURRENTLY IF NOT EXISTS android_push_delivery_due_index ON android_push_delivery (next_attempt_at, id) WHERE status IN ('pending', 'retry', 'delivering');
