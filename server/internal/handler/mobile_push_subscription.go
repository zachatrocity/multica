package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type mobilePushSubscriptionResponse struct {
	ID            string  `json:"id"`
	Provider      string  `json:"provider"`
	DeviceName    *string `json:"device_name"`
	AppVariant    string  `json:"app_variant"`
	CreatedAt     string  `json:"created_at"`
	UpdatedAt     string  `json:"updated_at"`
	LastSuccessAt *string `json:"last_success_at"`
	LastFailureAt *string `json:"last_failure_at"`
	FailureCount  int32   `json:"failure_count"`
}

func mobilePushSubscriptionToResponse(sub db.MobilePushSubscription) mobilePushSubscriptionResponse {
	return mobilePushSubscriptionResponse{
		ID:            uuidToString(sub.ID),
		Provider:      sub.Provider,
		DeviceName:    textToPtr(sub.DeviceName),
		AppVariant:    sub.AppVariant,
		CreatedAt:     timestampToString(sub.CreatedAt),
		UpdatedAt:     timestampToString(sub.UpdatedAt),
		LastSuccessAt: timestampToPtr(sub.LastSuccessAt),
		LastFailureAt: timestampToPtr(sub.LastFailureAt),
		FailureCount:  sub.FailureCount,
	}
}

func (h *Handler) ListMobilePushSubscriptions(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	subs, err := h.Queries.ListMobilePushSubscriptionsByUser(r.Context(), parseUUID(userID))
	if err != nil {
		slog.Warn("ListMobilePushSubscriptions failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list mobile push subscriptions")
		return
	}

	resp := make([]mobilePushSubscriptionResponse, 0, len(subs))
	for _, sub := range subs {
		resp = append(resp, mobilePushSubscriptionToResponse(sub))
	}
	writeJSON(w, http.StatusOK, resp)
}

type upsertMobilePushSubscriptionRequest struct {
	Provider   string  `json:"provider"`
	Token      string  `json:"token"`
	DeviceName *string `json:"device_name"`
	AppVariant string  `json:"app_variant"`
}

func (h *Handler) UpsertMobilePushSubscription(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req upsertMobilePushSubscriptionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req.Provider = strings.TrimSpace(req.Provider)
	req.Token = strings.TrimSpace(req.Token)
	req.AppVariant = strings.TrimSpace(req.AppVariant)
	if req.AppVariant == "" {
		req.AppVariant = "production"
	}
	if req.Provider != "expo" && req.Provider != "unifiedpush" {
		writeError(w, http.StatusBadRequest, "invalid push provider")
		return
	}
	if req.Token == "" {
		writeError(w, http.StatusBadRequest, "token is required")
		return
	}
	if len(req.Token) > 4096 {
		writeError(w, http.StatusBadRequest, "token is too long")
		return
	}
	if req.DeviceName != nil {
		deviceName := strings.TrimSpace(*req.DeviceName)
		if deviceName == "" {
			req.DeviceName = nil
		} else {
			req.DeviceName = &deviceName
		}
	}
	if len(req.AppVariant) > 64 {
		writeError(w, http.StatusBadRequest, "app_variant is too long")
		return
	}

	sub, err := h.Queries.UpsertMobilePushSubscription(r.Context(), db.UpsertMobilePushSubscriptionParams{
		UserID:     parseUUID(userID),
		Provider:   req.Provider,
		Token:      req.Token,
		DeviceName: ptrToText(req.DeviceName),
		AppVariant: req.AppVariant,
	})
	if err != nil {
		slog.Warn("UpsertMobilePushSubscription failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to register mobile push subscription")
		return
	}

	writeJSON(w, http.StatusOK, mobilePushSubscriptionToResponse(sub))
}

func (h *Handler) DeleteMobilePushSubscription(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	subID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "subscription id")
	if !ok {
		return
	}

	rows, err := h.Queries.DeleteMobilePushSubscription(r.Context(), db.DeleteMobilePushSubscriptionParams{
		ID:     subID,
		UserID: parseUUID(userID),
	})
	if err != nil {
		slog.Warn("DeleteMobilePushSubscription failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete mobile push subscription")
		return
	}
	if rows == 0 {
		writeError(w, http.StatusNotFound, "mobile push subscription not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
