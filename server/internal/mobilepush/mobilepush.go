package mobilepush

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const expoPushURL = "https://exp.host/--/api/v2/push/send"

var httpClient = &http.Client{Timeout: 5 * time.Second}

type pushPayload struct {
	WorkspaceID   string  `json:"workspace_id"`
	WorkspaceSlug string  `json:"workspace_slug"`
	InboxItemID   string  `json:"inbox_item_id"`
	IssueID       *string `json:"issue_id,omitempty"`
	Title         string  `json:"title"`
	Body          string  `json:"body,omitempty"`
	Type          string  `json:"type"`
	Severity      string  `json:"severity"`
}

// SendForInboxItem delivers native mobile push for a persisted inbox row.
// It is intentionally best-effort: callers should invoke it after the inbox
// write has succeeded, and delivery failures only update subscription health.
func SendForInboxItem(ctx context.Context, queries *db.Queries, item db.InboxItem) {
	if item.RecipientType != "member" {
		return
	}
	if systemNotificationsMuted(ctx, queries, item) {
		return
	}

	subs, err := queries.ListMobilePushSubscriptionsByUser(ctx, item.RecipientID)
	if err != nil {
		slog.Warn("mobile push: list subscriptions failed",
			"recipient_id", util.UUIDToString(item.RecipientID),
			"error", err)
		return
	}
	if len(subs) == 0 {
		return
	}

	workspace, err := queries.GetWorkspace(ctx, item.WorkspaceID)
	if err != nil {
		slog.Warn("mobile push: load workspace failed",
			"workspace_id", util.UUIDToString(item.WorkspaceID),
			"error", err)
		return
	}

	payload := pushPayload{
		WorkspaceID:   util.UUIDToString(item.WorkspaceID),
		WorkspaceSlug: workspace.Slug,
		InboxItemID:   util.UUIDToString(item.ID),
		IssueID:       util.UUIDToPtr(item.IssueID),
		Title:         item.Title,
		Body:          strings.TrimSpace(item.Body.String),
		Type:          item.Type,
		Severity:      item.Severity,
	}

	for _, sub := range subs {
		if err := send(ctx, sub, payload); err != nil {
			slog.Warn("mobile push: send failed",
				"subscription_id", util.UUIDToString(sub.ID),
				"provider", sub.Provider,
				"error", err)
			_, _ = queries.MarkMobilePushSubscriptionFailure(ctx, sub.ID)
			continue
		}
		_, _ = queries.MarkMobilePushSubscriptionSuccess(ctx, sub.ID)
	}
}

func systemNotificationsMuted(ctx context.Context, queries *db.Queries, item db.InboxItem) bool {
	pref, err := queries.GetNotificationPreference(ctx, db.GetNotificationPreferenceParams{
		WorkspaceID: item.WorkspaceID,
		UserID:      item.RecipientID,
	})
	if err != nil {
		return !errors.Is(err, pgx.ErrNoRows)
	}
	var prefs map[string]string
	if err := json.Unmarshal(pref.Preferences, &prefs); err != nil {
		return false
	}
	return prefs["system_notifications"] == "muted"
}

func send(ctx context.Context, sub db.MobilePushSubscription, payload pushPayload) error {
	switch sub.Provider {
	case "expo":
		return sendExpo(ctx, sub.Token, payload)
	case "unifiedpush":
		return sendUnifiedPush(ctx, sub.Token, payload)
	default:
		return errors.New("unsupported mobile push provider")
	}
}

func sendExpo(ctx context.Context, token string, payload pushPayload) error {
	body := map[string]any{
		"to":       token,
		"title":    payload.Title,
		"body":     payload.Body,
		"sound":    "default",
		"priority": "high",
		"data":     payload,
	}
	return postJSON(ctx, expoPushURL, body, true)
}

func sendUnifiedPush(ctx context.Context, endpoint string, payload pushPayload) error {
	return postJSON(ctx, endpoint, payload, false)
}

func postJSON(ctx context.Context, url string, body any, parseExpo bool) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return errors.New("push provider returned " + res.Status)
	}
	if !parseExpo {
		return nil
	}

	var parsed struct {
		Data struct {
			Status  string `json:"status"`
			Message string `json:"message"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return err
	}
	if parsed.Data.Status == "error" {
		if parsed.Data.Message != "" {
			return errors.New(parsed.Data.Message)
		}
		return errors.New("expo push service returned an error")
	}
	return nil
}
