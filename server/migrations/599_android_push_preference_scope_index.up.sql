CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS android_push_preference_scope_index ON android_push_preference (workspace_id, user_id);
