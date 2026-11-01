CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS android_push_delivery_inbox_index ON android_push_delivery (endpoint_id, inbox_item_id) WHERE inbox_item_id IS NOT NULL;
