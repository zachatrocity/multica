CREATE INDEX CONCURRENTLY IF NOT EXISTS android_push_endpoint_expiry_index ON android_push_endpoint (expires_at, id) WHERE status = 'active';
