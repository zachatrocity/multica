package androidpush

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
)

var (
	ErrEndpointNotFound   = errors.New("android push endpoint not found")
	ErrPreferenceDisabled = errors.New("android alerts are disabled for this workspace")
)

type Service struct {
	pool         *pgxpool.Pool
	baseURL      *url.URL
	accessToken  string
	box          *secretbox.Box
	hashKey      []byte
	httpClient   *http.Client
	logger       *slog.Logger
	pollInterval time.Duration
	endpointTTL  time.Duration
	wake         chan struct{}
}

type Endpoint struct {
	ID            string     `json:"id"`
	DeviceID      string     `json:"device_id"`
	AppVariant    string     `json:"app_variant"`
	Status        string     `json:"status"`
	FailureCount  int32      `json:"failure_count"`
	LastSuccessAt *time.Time `json:"last_success_at"`
	LastFailureAt *time.Time `json:"last_failure_at"`
	ExpiresAt     time.Time  `json:"expires_at"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type Preference struct {
	WorkspaceID    string `json:"workspace_id"`
	Enabled        bool   `json:"enabled"`
	Mentions       bool   `json:"mentions"`
	Assignments    bool   `json:"assignments"`
	ReviewBlockers bool   `json:"review_blockers"`
	Comments       bool   `json:"comments"`
	RoutineUpdates bool   `json:"routine_updates"`
}

type PreferencePatch struct {
	Enabled        *bool
	Mentions       *bool
	Assignments    *bool
	ReviewBlockers *bool
	Comments       *bool
	RoutineUpdates *bool
}

type TestResult struct {
	EventID string `json:"event_id"`
	Status  string `json:"status"`
}
type Category string

const (
	CategoryMentions       Category = "mentions"
	CategoryAssignments    Category = "assignments"
	CategoryReviewBlockers Category = "review_blockers"
	CategoryComments       Category = "comments"
	CategoryRoutineUpdates Category = "routine_updates"
)

type Notification struct {
	EventID     string
	WorkspaceID string
	UserID      string
	IssueID     string
	CommentID   string
	InboxItemID *string
	EventType   string
	Category    Category
	ActorType   string
	ActorID     string
	Title       string
	Body        string
	Details     []byte
}

func timestampPtr(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time
	return &v
}

func scanEndpoint(row pgx.Row) (Endpoint, error) {
	var endpoint Endpoint
	var success, failure pgtype.Timestamptz
	err := row.Scan(
		&endpoint.ID,
		&endpoint.DeviceID,
		&endpoint.AppVariant,
		&endpoint.Status,
		&endpoint.FailureCount,
		&success,
		&failure,
		&endpoint.ExpiresAt,
		&endpoint.CreatedAt,
		&endpoint.UpdatedAt,
	)
	endpoint.LastSuccessAt = timestampPtr(success)
	endpoint.LastFailureAt = timestampPtr(failure)
	return endpoint, err
}

const endpointProjection = `
	id::text, device_id, app_variant, status, failure_count,
	last_success_at, last_failure_at, expires_at, created_at, updated_at`

func (s *Service) endpointAllowed(raw string) (*url.URL, error) {
	endpoint, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || endpoint.Host == "" {
		return nil, errors.New("invalid UnifiedPush endpoint")
	}
	if endpoint.Scheme != s.baseURL.Scheme || !strings.EqualFold(endpoint.Host, s.baseURL.Host) {
		return nil, errors.New("UnifiedPush endpoint is outside the configured ntfy server")
	}
	if endpoint.User != nil || endpoint.Fragment != "" {
		return nil, errors.New("invalid UnifiedPush endpoint")
	}
	basePath := strings.TrimRight(s.baseURL.EscapedPath(), "/")
	endpointPath := endpoint.EscapedPath()
	if basePath != "" && endpointPath != basePath && !strings.HasPrefix(endpointPath, basePath+"/") {
		return nil, errors.New("UnifiedPush endpoint is outside the configured ntfy path")
	}
	return endpoint, nil
}

func (s *Service) endpointHash(endpoint string) []byte {
	mac := hmac.New(sha256.New, s.hashKey)
	_, _ = mac.Write([]byte(endpoint))
	return mac.Sum(nil)
}

func (s *Service) RegisterEndpoint(ctx context.Context, userID, deviceID, rawEndpoint, appVariant string) (Endpoint, error) {
	endpoint, err := s.endpointAllowed(rawEndpoint)
	if err != nil {
		return Endpoint{}, err
	}
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" || len(deviceID) > 128 {
		return Endpoint{}, errors.New("device_id must be between 1 and 128 characters")
	}
	appVariant = strings.TrimSpace(appVariant)
	if appVariant == "" {
		appVariant = "production"
	}
	if len(appVariant) > 64 {
		return Endpoint{}, errors.New("app_variant is too long")
	}
	sealed, err := s.box.Seal([]byte(endpoint.String()))
	if err != nil {
		return Endpoint{}, err
	}
	expiresAt := time.Now().Add(s.endpointTTL)
	row := s.pool.QueryRow(ctx, `
		INSERT INTO android_push_endpoint (
			user_id, device_id, endpoint_encrypted, endpoint_hash, app_variant, expires_at
		) VALUES ($1::uuid, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id, device_id) DO UPDATE SET
			endpoint_encrypted = EXCLUDED.endpoint_encrypted,
			endpoint_hash = EXCLUDED.endpoint_hash,
			app_variant = EXCLUDED.app_variant,
			status = 'active',
			failure_count = 0,
			last_failure_at = NULL,
			active_since = CASE
				WHEN android_push_endpoint.endpoint_hash = EXCLUDED.endpoint_hash
					THEN android_push_endpoint.active_since
				ELSE now()
			END,
			expires_at = EXCLUDED.expires_at,
			disabled_at = NULL,
			updated_at = now()
		RETURNING `+endpointProjection,
		userID, deviceID, sealed, s.endpointHash(endpoint.String()), appVariant, expiresAt)
	registered, err := scanEndpoint(row)
	if err == nil {
		s.Wake()
	}
	return registered, err
}

func (s *Service) ListEndpoints(ctx context.Context, userID string) ([]Endpoint, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+endpointProjection+`
		FROM android_push_endpoint WHERE user_id = $1::uuid ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	endpoints := make([]Endpoint, 0)
	for rows.Next() {
		endpoint, err := scanEndpoint(rows)
		if err != nil {
			return nil, err
		}
		endpoints = append(endpoints, endpoint)
	}
	return endpoints, rows.Err()
}

func (s *Service) SetEndpointEnabled(ctx context.Context, userID, endpointID string, enabled bool) (Endpoint, error) {
	status := "disabled"
	if enabled {
		status = "active"
	}
	row := s.pool.QueryRow(ctx, `UPDATE android_push_endpoint SET
		status = $3,
		active_since = CASE WHEN $3 = 'active' THEN now() ELSE active_since END,
		expires_at = CASE WHEN $3 = 'active' THEN now() + $4::interval ELSE expires_at END,
		disabled_at = CASE WHEN $3 = 'active' THEN NULL ELSE now() END,
		failure_count = CASE WHEN $3 = 'active' THEN 0 ELSE failure_count END,
		updated_at = now()
		WHERE id = $1::uuid AND user_id = $2::uuid
		RETURNING `+endpointProjection,
		endpointID, userID, status, fmt.Sprintf("%d seconds", int64(s.endpointTTL.Seconds())))
	endpoint, err := scanEndpoint(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Endpoint{}, ErrEndpointNotFound
	}
	if err == nil {
		if enabled {
			s.Wake()
		} else if _, deleteErr := s.pool.Exec(ctx, `
			DELETE FROM android_push_delivery
			WHERE endpoint_id = $1::uuid AND status IN ('pending', 'retry', 'delivering')`, endpointID); deleteErr != nil {
			return Endpoint{}, deleteErr
		}
	}
	return endpoint, err
}

func (s *Service) DeleteEndpoint(ctx context.Context, userID, endpointID string) error {
	return s.deleteEndpoint(ctx, userID, "id = $2::uuid", endpointID)
}

func (s *Service) RevokeDevice(ctx context.Context, userID, deviceID string) error {
	return s.deleteEndpoint(ctx, userID, "device_id = $2", strings.TrimSpace(deviceID))
}

func (s *Service) deleteEndpoint(ctx context.Context, userID, predicate, value string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var endpointID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM android_push_endpoint WHERE user_id = $1::uuid AND `+predicate, userID, value).Scan(&endpointID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrEndpointNotFound
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM android_push_delivery WHERE endpoint_id = $1::uuid`, endpointID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM android_push_endpoint WHERE id = $1::uuid AND user_id = $2::uuid`, endpointID, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func defaultPreference(workspaceID string) Preference {
	return Preference{
		WorkspaceID:    workspaceID,
		Mentions:       true,
		Assignments:    true,
		ReviewBlockers: true,
	}
}

func scanPreference(row pgx.Row) (Preference, error) {
	var pref Preference
	err := row.Scan(&pref.WorkspaceID, &pref.Enabled, &pref.Mentions, &pref.Assignments, &pref.ReviewBlockers, &pref.Comments, &pref.RoutineUpdates)
	return pref, err
}

func (s *Service) GetPreference(ctx context.Context, workspaceID, userID string) (Preference, error) {
	pref, err := scanPreference(s.pool.QueryRow(ctx, `SELECT workspace_id::text, enabled, mentions, assignments,
		review_blockers, comments, routine_updates FROM android_push_preference
		WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, workspaceID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return defaultPreference(workspaceID), nil
	}
	return pref, err
}

func (s *Service) PatchPreference(ctx context.Context, workspaceID, userID string, patch PreferencePatch) (Preference, error) {
	pref, err := scanPreference(s.pool.QueryRow(ctx, `
		INSERT INTO android_push_preference (
			workspace_id, user_id, enabled, mentions, assignments, review_blockers, comments, routine_updates, enabled_at
		) VALUES (
			$1::uuid, $2::uuid, COALESCE($3::boolean, false), COALESCE($4::boolean, true),
			COALESCE($5::boolean, true), COALESCE($6::boolean, true), COALESCE($7::boolean, false),
			COALESCE($8::boolean, false), CASE WHEN COALESCE($3::boolean, false) THEN now() END
		)
		ON CONFLICT (workspace_id, user_id) DO UPDATE SET
			enabled = COALESCE($3::boolean, android_push_preference.enabled),
			mentions = COALESCE($4::boolean, android_push_preference.mentions),
			assignments = COALESCE($5::boolean, android_push_preference.assignments),
			review_blockers = COALESCE($6::boolean, android_push_preference.review_blockers),
			comments = COALESCE($7::boolean, android_push_preference.comments),
			routine_updates = COALESCE($8::boolean, android_push_preference.routine_updates),
			enabled_at = CASE
				WHEN COALESCE($3::boolean, android_push_preference.enabled) = false THEN NULL
				WHEN android_push_preference.enabled = false THEN now()
				ELSE android_push_preference.enabled_at
			END,
			updated_at = now()
		RETURNING workspace_id::text, enabled, mentions, assignments, review_blockers, comments, routine_updates`,
		workspaceID, userID, patch.Enabled, patch.Mentions, patch.Assignments, patch.ReviewBlockers, patch.Comments, patch.RoutineUpdates))
	if err == nil && pref.Enabled {
		s.Wake()
	}
	return pref, err
}
func (s *Service) Enqueue(ctx context.Context, notification Notification) (bool, error) {
	inboxItemID := ""
	if notification.InboxItemID != nil {
		inboxItemID = *notification.InboxItemID
	}
	details := notification.Details
	if len(details) == 0 || !json.Valid(details) {
		details = []byte("{}")
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO android_push_delivery (
			endpoint_id, inbox_item_id, event_id, workspace_id, issue_id, comment_id, event_type,
			actor_type, actor_id, event_category, event_title, event_body, event_details
		)
		SELECT e.id, NULLIF($4, '')::uuid, $1::uuid, $2::uuid,
			NULLIF($5, '')::uuid, NULLIF($6, '')::uuid, $7,
			NULLIF($9, ''), NULLIF($10, '')::uuid, $8, $11, $12, $13::jsonb
		FROM android_push_endpoint e
		JOIN android_push_preference p
			ON p.workspace_id = $2::uuid AND p.user_id = e.user_id
		WHERE e.user_id = $3::uuid
			AND e.status = 'active'
			AND e.expires_at > now()
			AND p.enabled
			AND EXISTS (
				SELECT 1 FROM member m
				WHERE m.workspace_id = $2::uuid AND m.user_id = $3::uuid
			)
			AND (
				($8 = 'mentions' AND p.mentions)
				OR ($8 = 'assignments' AND p.assignments)
				OR ($8 = 'review_blockers' AND p.review_blockers)
				OR ($8 = 'comments' AND p.comments)
				OR ($8 = 'routine_updates' AND p.routine_updates)
			)
		ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
		notification.EventID, notification.WorkspaceID, notification.UserID, inboxItemID,
		notification.IssueID, notification.CommentID, notification.EventType, notification.Category,
		notification.ActorType, notification.ActorID, notification.Title, notification.Body, details)
	if err != nil {
		return false, err
	}
	queued := tag.RowsAffected() > 0
	if queued {
		s.Wake()
	}
	return queued, nil
}

func (s *Service) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()
	cleanupTicker := time.NewTicker(time.Hour)
	defer cleanupTicker.Stop()
	s.runBatch(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runBatch(ctx)
		case <-s.wake:
			s.runBatch(ctx)
		case <-cleanupTicker.C:
			if err := s.Cleanup(ctx); err != nil {
				s.logger.Error("android push cleanup failed", "error", err)
			}
		}
	}
}

func (s *Service) runBatch(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	if _, err := s.enqueueInboxDeliveries(ctx, 200); err != nil {
		s.logger.Error("android push enqueue failed", "error", err)
		return
	}
	for range 200 {
		delivered, _, err := s.processOne(ctx, "")
		if err != nil {
			s.logger.Error("android push worker failed", "error", err)
			return
		}
		if !delivered {
			return
		}
	}
}

func (s *Service) enqueueInboxDeliveries(ctx context.Context, limit int) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO android_push_delivery (
			endpoint_id, inbox_item_id, event_id, workspace_id, issue_id, comment_id, event_type,
			actor_type, actor_id, event_category, event_title, event_body, event_details
		)
		SELECT e.id, i.id, i.id, i.workspace_id, i.issue_id,
			CASE WHEN COALESCE(i.details->>'comment_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
				THEN (i.details->>'comment_id')::uuid END,
			i.type, i.actor_type, i.actor_id,
			CASE
				WHEN i.type = 'mentioned' THEN 'mentions'
				WHEN i.type IN ('issue_assigned', 'unassigned', 'assignee_changed') THEN 'assignments'
				WHEN i.type IN ('task_failed', 'agent_blocked', 'children_done') THEN 'review_blockers'
				WHEN i.type = 'status_changed' AND (
					(i.details->>'to') IN ('in_review', 'blocked', 'done', 'cancelled')
					OR EXISTS (
						SELECT 1 FROM issue_status s
						WHERE s.workspace_id = i.workspace_id AND s.key = i.details->>'to'
						AND (s.category IN ('done', 'closed') OR (s.category = 'started' AND s.key <> 'in_progress'))
					)
				) THEN 'review_blockers'
				WHEN i.type = 'new_comment' THEN 'comments'
				ELSE 'routine_updates'
			END,
			i.title, COALESCE(i.body, ''), i.details
		FROM inbox_item i
		JOIN android_push_endpoint e
			ON e.user_id = i.recipient_id AND i.recipient_type = 'member'
		JOIN android_push_preference p
			ON p.workspace_id = i.workspace_id AND p.user_id = i.recipient_id
		WHERE e.status = 'active'
			AND e.expires_at > now()
			AND p.enabled
			AND p.enabled_at IS NOT NULL
			AND i.created_at >= GREATEST(e.active_since, p.enabled_at)
			AND i.created_at >= now() - interval '7 days'
			AND EXISTS (
				SELECT 1 FROM member m
				WHERE m.workspace_id = i.workspace_id AND m.user_id = i.recipient_id
			)
			AND (
				(i.type = 'mentioned' AND p.mentions)
				OR (i.type IN ('issue_assigned', 'unassigned', 'assignee_changed') AND p.assignments)
				OR (i.type IN ('task_failed', 'agent_blocked', 'children_done') AND p.review_blockers)
				OR (i.type = 'status_changed' AND p.review_blockers AND (
					(i.details->>'to') IN ('in_review', 'blocked', 'done', 'cancelled')
					OR EXISTS (
						SELECT 1 FROM issue_status s
						WHERE s.workspace_id = i.workspace_id AND s.key = i.details->>'to'
						AND (s.category IN ('done', 'closed') OR (s.category = 'started' AND s.key <> 'in_progress'))
					)
				))
				OR (i.type = 'new_comment' AND p.comments)
				OR (i.type IN ('priority_changed', 'start_date_changed', 'due_date_changed', 'reaction_added', 'task_completed', 'agent_completed') AND p.routine_updates)
				OR (i.type = 'status_changed' AND p.routine_updates)
			)
		ORDER BY i.created_at, i.id, e.id
		LIMIT $1
		ON CONFLICT (endpoint_id, event_id) DO NOTHING`, limit)
	return tag.RowsAffected(), err
}

type claimedDelivery struct {
	ID                string
	EndpointID        string
	EndpointEncrypted []byte
	EventID           string
	WorkspaceID       string
	IssueID           *string
	CommentID         *string
	InboxItemID       *string
	EventType         string
	ActorType         string
	ActorID           *string
	EventCategory     string
	EventTitle        string
	EventBody         string
	EventDetails      []byte
	Attempts          int32
}

func scanClaim(row pgx.Row) (claimedDelivery, error) {
	var delivery claimedDelivery
	var issueID, commentID, inboxItemID, actorID pgtype.UUID
	err := row.Scan(&delivery.ID, &delivery.EndpointID, &delivery.EndpointEncrypted, &delivery.EventID,
		&delivery.WorkspaceID, &issueID, &commentID, &inboxItemID, &delivery.EventType,
		&delivery.ActorType, &actorID, &delivery.EventCategory, &delivery.EventTitle,
		&delivery.EventBody, &delivery.EventDetails, &delivery.Attempts)
	if issueID.Valid {
		value := uuid.UUID(issueID.Bytes).String()
		delivery.IssueID = &value
	}
	if commentID.Valid {
		value := uuid.UUID(commentID.Bytes).String()
		delivery.CommentID = &value
	}
	if inboxItemID.Valid {
		value := uuid.UUID(inboxItemID.Bytes).String()
		delivery.InboxItemID = &value
	}
	if actorID.Valid {
		value := uuid.UUID(actorID.Bytes).String()
		delivery.ActorID = &value
	}
	return delivery, err
}

func (s *Service) claimOne(ctx context.Context, deliveryID string) (claimedDelivery, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return claimedDelivery{}, err
	}
	defer tx.Rollback(ctx)
	query := `
		WITH candidate AS (
			SELECT d.id FROM android_push_delivery d
			JOIN android_push_endpoint active_endpoint ON active_endpoint.id = d.endpoint_id
			WHERE active_endpoint.status = 'active'
				AND active_endpoint.expires_at > now()
				AND (
					(d.status IN ('pending', 'retry') AND d.next_attempt_at <= now())
					OR (d.status = 'delivering' AND d.lease_until < now())
				)`
	args := []any{}
	if deliveryID != "" {
		query += ` AND d.id = $1::uuid`
		args = append(args, deliveryID)
	}
	query += ` ORDER BY d.next_attempt_at, d.id FOR UPDATE SKIP LOCKED LIMIT 1
		)
		UPDATE android_push_delivery d SET
			status = 'delivering', attempts = attempts + 1, lease_until = now() + interval '30 seconds'
		FROM candidate c, android_push_endpoint e
		WHERE d.id = c.id AND e.id = d.endpoint_id
		RETURNING d.id::text, d.endpoint_id::text, e.endpoint_encrypted, d.event_id::text,
			d.workspace_id::text, d.issue_id, d.comment_id, d.inbox_item_id, d.event_type,
			COALESCE(d.actor_type, ''), d.actor_id, d.event_category, d.event_title,
			d.event_body, d.event_details, d.attempts`
	delivery, err := scanClaim(tx.QueryRow(ctx, query, args...))
	if err != nil {
		return claimedDelivery{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return claimedDelivery{}, err
	}
	return delivery, nil
}

type payload struct {
	Version       int     `json:"version"`
	EventID       string  `json:"event_id"`
	EventType     string  `json:"event_type"`
	WorkspaceID   string  `json:"workspace_id"`
	WorkspaceSlug string  `json:"workspace_slug"`
	WorkspaceName string  `json:"workspace_name"`
	IssueID       *string `json:"issue_id,omitempty"`
	CommentID     *string `json:"comment_id,omitempty"`
	InboxItemID   *string `json:"inbox_item_id,omitempty"`
	Title         string  `json:"title"`
	Body          string  `json:"body"`
	ExpandedBody  string  `json:"expanded_body,omitempty"`
	Channel       string  `json:"channel"`
}

var markdownLinkPattern = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`)

var markdownMarkerReplacer = strings.NewReplacer(
	"**", "",
	"__", "",
	"~~", "",
	"`", "",
	"#", "",
	">", "",
)

type notificationContext struct {
	WorkspaceSlug string
	WorkspaceName string
	IssueRef      string
	IssueTitle    string
	ActorName     string
}

type notificationCopy struct {
	Title        string
	Body         string
	ExpandedBody string
	Channel      string
}

func plainText(value string, limit int) string {
	value = markdownLinkPattern.ReplaceAllString(value, "$1")
	value = markdownMarkerReplacer.Replace(value)
	value = strings.Join(strings.Fields(value), " ")
	if len(value) <= limit {
		return value
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

func notificationDisplay(delivery claimedDelivery, info notificationContext) notificationCopy {
	issueTitle := plainText(info.IssueTitle, 120)
	workspaceName := plainText(info.WorkspaceName, 80)
	actorName := plainText(info.ActorName, 60)
	excerpt := plainText(delivery.EventBody, 180)
	issueRef := info.IssueRef
	if issueRef == "" {
		issueRef = "Issue"
	}
	issueSummary := issueRef
	if issueTitle != "" {
		issueSummary += " · " + issueTitle
	}
	withWorkspace := issueSummary
	if workspaceName != "" {
		withWorkspace += " · " + workspaceName
	}
	titleWithWorkspace := issueTitle
	if titleWithWorkspace == "" {
		titleWithWorkspace = issueRef
	}
	if workspaceName != "" {
		titleWithWorkspace += " · " + workspaceName
	}
	expanded := withWorkspace
	if excerpt != "" && excerpt != issueTitle {
		expanded += "\n“" + excerpt + "”"
	}
	channel := "activity"
	if delivery.EventCategory == string(CategoryMentions) ||
		delivery.EventCategory == string(CategoryAssignments) ||
		delivery.EventCategory == string(CategoryReviewBlockers) ||
		delivery.EventType == "test" {
		channel = "action_needed"
	}

	switch delivery.EventType {
	case "test":
		return notificationCopy{
			Title:        "Multica alerts are working",
			Body:         "Tap to open notification settings.",
			ExpandedBody: "This device can receive private Multica alerts through ntfy.",
			Channel:      channel,
		}
	case "mentioned":
		title := "You were mentioned"
		if actorName != "" {
			title = actorName + " mentioned you"
		}
		return notificationCopy{Title: title, Body: issueSummary, ExpandedBody: expanded, Channel: channel}
	case "issue_assigned":
		return notificationCopy{Title: issueRef + " assigned to you", Body: titleWithWorkspace, ExpandedBody: expanded, Channel: channel}
	case "unassigned", "assignee_changed":
		return notificationCopy{Title: "Assignment changed · " + issueRef, Body: withWorkspace, ExpandedBody: expanded, Channel: channel}
	case "new_comment":
		title := "New comment"
		if actorName != "" {
			title = actorName + " commented"
		}
		return notificationCopy{Title: title, Body: issueSummary, ExpandedBody: expanded, Channel: channel}
	case "task_failed", "agent_blocked":
		return notificationCopy{Title: "Agent needs attention · " + issueRef, Body: withWorkspace, ExpandedBody: expanded, Channel: channel}
	case "children_done", "review_requested":
		return notificationCopy{Title: "Review needed · " + issueRef, Body: withWorkspace, ExpandedBody: expanded, Channel: channel}
	case "status_changed":
		var detail struct {
			To string `json:"to"`
		}
		_ = json.Unmarshal(delivery.EventDetails, &detail)
		switch detail.To {
		case "in_review", "done":
			return notificationCopy{Title: "Review needed · " + issueRef, Body: withWorkspace, ExpandedBody: expanded, Channel: channel}
		case "blocked", "cancelled":
			return notificationCopy{Title: "Issue needs attention · " + issueRef, Body: withWorkspace, ExpandedBody: expanded, Channel: channel}
		default:
			status := plainText(strings.ReplaceAll(detail.To, "_", " "), 40)
			title := issueRef + " updated"
			if status != "" {
				title = issueRef + " moved to " + status
			}
			return notificationCopy{Title: title, Body: withWorkspace, ExpandedBody: expanded, Channel: channel}
		}
	default:
		return notificationCopy{Title: issueRef + " updated", Body: withWorkspace, ExpandedBody: expanded, Channel: channel}
	}
}

func (s *Service) buildPayload(ctx context.Context, delivery claimedDelivery) (payload, error) {
	issueID := ""
	if delivery.IssueID != nil {
		issueID = *delivery.IssueID
	}
	actorID := ""
	if delivery.ActorID != nil {
		actorID = *delivery.ActorID
	}
	var info notificationContext
	var issuePrefix string
	var issueNumber int32
	err := s.pool.QueryRow(ctx, `
		SELECT w.slug, w.name, w.issue_prefix,
			COALESCE(i.number, 0), COALESCE(i.title, $5),
			COALESCE(u.name, a.name, '')
		FROM workspace w
		LEFT JOIN issue i ON i.id = NULLIF($2, '')::uuid AND i.workspace_id = w.id
		LEFT JOIN "user" u ON $3 = 'member' AND u.id = NULLIF($4, '')::uuid
			AND EXISTS (SELECT 1 FROM member m WHERE m.workspace_id = w.id AND m.user_id = u.id)
		LEFT JOIN agent a ON $3 = 'agent' AND a.id = NULLIF($4, '')::uuid AND a.workspace_id = w.id
		WHERE w.id = $1::uuid`,
		delivery.WorkspaceID, issueID, delivery.ActorType, actorID, delivery.EventTitle,
	).Scan(&info.WorkspaceSlug, &info.WorkspaceName, &issuePrefix, &issueNumber, &info.IssueTitle, &info.ActorName)
	if err != nil {
		return payload{}, err
	}
	if issueNumber > 0 {
		info.IssueRef = fmt.Sprintf("%s-%d", issuePrefix, issueNumber)
	}
	copy := notificationDisplay(delivery, info)
	return payload{
		Version:       1,
		EventID:       delivery.EventID,
		EventType:     delivery.EventType,
		WorkspaceID:   delivery.WorkspaceID,
		WorkspaceSlug: info.WorkspaceSlug,
		WorkspaceName: info.WorkspaceName,
		IssueID:       delivery.IssueID,
		CommentID:     delivery.CommentID,
		InboxItemID:   delivery.InboxItemID,
		Title:         copy.Title,
		Body:          copy.Body,
		ExpandedBody:  copy.ExpandedBody,
		Channel:       copy.Channel,
	}, nil
}

type deliveryOutcome struct {
	Status     string
	Code       string
	Retry      bool
	Disable    bool
	Quarantine bool
}

func (s *Service) processOne(ctx context.Context, deliveryID string) (bool, string, error) {
	delivery, err := s.claimOne(ctx, deliveryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, "", nil
	}
	if err != nil {
		return false, "", err
	}
	plaintext, err := s.box.Open(delivery.EndpointEncrypted)
	if err != nil {
		outcome := deliveryOutcome{Status: "failed", Code: "endpoint_decryption_failed", Quarantine: true}
		return true, outcome.Status, s.finishDelivery(ctx, delivery, outcome)
	}
	endpoint, err := s.endpointAllowed(string(plaintext))
	if err != nil {
		outcome := deliveryOutcome{Status: "failed", Code: "endpoint_invalid", Quarantine: true}
		return true, outcome.Status, s.finishDelivery(ctx, delivery, outcome)
	}
	notificationPayload, err := s.buildPayload(ctx, delivery)
	if err != nil {
		return true, "", err
	}
	body, err := json.Marshal(notificationPayload)
	if err != nil {
		return true, "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return true, "", err
	}
	request.Header.Set("Authorization", "Bearer "+s.accessToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Idempotency-Key", delivery.EventID)
	response, requestErr := s.httpClient.Do(request)
	outcome := classifyDelivery(response, requestErr)
	if response != nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		_ = response.Body.Close()
	}
	if err := s.finishDelivery(ctx, delivery, outcome); err != nil {
		return true, outcome.Status, err
	}
	return true, outcome.Status, nil
}

func classifyDelivery(response *http.Response, err error) deliveryOutcome {
	if err != nil {
		return deliveryOutcome{Status: "retry", Code: "transport_error", Retry: true}
	}
	status := response.StatusCode
	switch {
	case status >= 200 && status < 300:
		return deliveryOutcome{Status: "sent"}
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return deliveryOutcome{Status: "failed", Code: "authorization_failed", Quarantine: true}
	case status == http.StatusNotFound || status == http.StatusGone:
		return deliveryOutcome{Status: "failed", Code: "endpoint_gone", Disable: true}
	case status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500:
		return deliveryOutcome{Status: "retry", Code: "provider_unavailable", Retry: true}
	default:
		return deliveryOutcome{Status: "failed", Code: "provider_rejected"}
	}
}

func retryDelay(attempts int32) time.Duration {
	delays := [...]time.Duration{time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 8 * time.Hour}
	index := int(attempts) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(delays) {
		index = len(delays) - 1
	}
	return delays[index]
}

func (s *Service) finishDelivery(ctx context.Context, delivery claimedDelivery, outcome deliveryOutcome) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	status := outcome.Status
	if outcome.Retry && delivery.Attempts >= 8 {
		status = "failed"
		outcome.Retry = false
		outcome.Code = "retry_exhausted"
	}
	if status == "sent" {
		_, err = tx.Exec(ctx, `UPDATE android_push_delivery SET status = 'sent', sent_at = now(),
			lease_until = NULL, last_error_code = '' WHERE id = $1::uuid`, delivery.ID)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE android_push_endpoint SET failure_count = 0,
				last_success_at = now(), last_failure_at = NULL, updated_at = now()
				WHERE id = $1::uuid`, delivery.EndpointID)
		}
	} else {
		nextAttempt := time.Now().Add(retryDelay(delivery.Attempts))
		_, err = tx.Exec(ctx, `UPDATE android_push_delivery SET status = $2, next_attempt_at = $3,
			lease_until = NULL, last_error_code = $4 WHERE id = $1::uuid`,
			delivery.ID, status, nextAttempt, outcome.Code)
		if err == nil {
			endpointStatus := "active"
			if outcome.Quarantine {
				endpointStatus = "quarantined"
			} else if outcome.Disable {
				endpointStatus = "disabled"
			}
			_, err = tx.Exec(ctx, `UPDATE android_push_endpoint SET
				status = CASE WHEN $2 = 'active' THEN status ELSE $2 END,
				failure_count = failure_count + 1,
				last_failure_at = now(),
				disabled_at = CASE WHEN $2 = 'active' THEN disabled_at ELSE now() END,
				updated_at = now()
				WHERE id = $1::uuid`, delivery.EndpointID, endpointStatus)
		}
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) SendTest(ctx context.Context, userID, workspaceID, deviceID string) (TestResult, error) {
	var endpointID string
	err := s.pool.QueryRow(ctx, `SELECT e.id::text
		FROM android_push_endpoint e
		JOIN android_push_preference p ON p.user_id = e.user_id AND p.workspace_id = $2::uuid
		WHERE e.user_id = $1::uuid AND e.device_id = $3 AND e.status = 'active'
			AND e.expires_at > now() AND p.enabled`, userID, workspaceID, strings.TrimSpace(deviceID)).Scan(&endpointID)
	if errors.Is(err, pgx.ErrNoRows) {
		var endpointExists bool
		_ = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM android_push_endpoint
			WHERE user_id = $1::uuid AND device_id = $2 AND status = 'active' AND expires_at > now())`,
			userID, strings.TrimSpace(deviceID)).Scan(&endpointExists)
		if endpointExists {
			return TestResult{}, ErrPreferenceDisabled
		}
		return TestResult{}, ErrEndpointNotFound
	}
	if err != nil {
		return TestResult{}, err
	}
	eventID := uuid.NewString()
	var deliveryID string
	err = s.pool.QueryRow(ctx, `INSERT INTO android_push_delivery (
		endpoint_id, event_id, workspace_id, event_type
	) VALUES ($1::uuid, $2::uuid, $3::uuid, 'test') RETURNING id::text`,
		endpointID, eventID, workspaceID).Scan(&deliveryID)
	if err != nil {
		return TestResult{}, err
	}
	processed, status, err := s.processOne(ctx, deliveryID)
	if err != nil {
		return TestResult{}, err
	}
	if !processed {
		return TestResult{}, errors.New("test delivery was not claimed")
	}
	return TestResult{EventID: eventID, Status: status}, nil
}

// Cleanup expires inactive registrations and removes stale delivery state.
// It is exported so maintenance and focused lifecycle tests can exercise the
// same operation as the hourly worker.
func (s *Service) Cleanup(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `UPDATE android_push_endpoint SET status = 'disabled',
		disabled_at = now(), updated_at = now()
		WHERE status = 'active' AND expires_at <= now()`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM android_push_delivery d
		WHERE d.created_at < now() - interval '30 days'
			OR NOT EXISTS (SELECT 1 FROM android_push_endpoint e WHERE e.id = d.endpoint_id)`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM android_push_endpoint
		WHERE status <> 'active' AND disabled_at < now() - interval '30 days'`); err != nil {
		return err
	}
	return nil
}
