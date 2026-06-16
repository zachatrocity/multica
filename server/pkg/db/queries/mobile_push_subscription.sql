-- name: ListMobilePushSubscriptionsByUser :many
SELECT * FROM mobile_push_subscription
WHERE user_id = $1 AND disabled_at IS NULL
ORDER BY updated_at DESC;

-- name: UpsertMobilePushSubscription :one
INSERT INTO mobile_push_subscription (user_id, provider, token, device_name, app_variant)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, provider, token)
DO UPDATE SET
  device_name = EXCLUDED.device_name,
  app_variant = EXCLUDED.app_variant,
  disabled_at = NULL,
  updated_at = now()
RETURNING *;

-- name: DeleteMobilePushSubscription :execrows
DELETE FROM mobile_push_subscription
WHERE id = $1 AND user_id = $2;

-- name: MarkMobilePushSubscriptionSuccess :exec
UPDATE mobile_push_subscription
SET last_success_at = now(),
    last_failure_at = NULL,
    failure_count = 0,
    updated_at = now()
WHERE id = $1;

-- name: MarkMobilePushSubscriptionFailure :exec
UPDATE mobile_push_subscription
SET last_failure_at = now(),
    failure_count = failure_count + 1,
    disabled_at = CASE
      WHEN failure_count + 1 >= 5 THEN now()
      ELSE disabled_at
    END,
    updated_at = now()
WHERE id = $1;
