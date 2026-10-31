CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS android_push_endpoint_device_index ON android_push_endpoint (user_id, device_id);
