package handler

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/androidpush"
	"github.com/multica-ai/multica/server/internal/logger"
)

func (h *Handler) requireAndroidPush(w http.ResponseWriter) (*androidpush.Service, bool) {
	if h.AndroidPush == nil {
		writeError(w, http.StatusServiceUnavailable, "Android alerts are not configured on this server")
		return nil, false
	}
	return h.AndroidPush, true
}

type registerAndroidPushEndpointRequest struct {
	DeviceID   string `json:"device_id"`
	Endpoint   string `json:"endpoint"`
	AppVariant string `json:"app_variant"`
}

func (h *Handler) RegisterAndroidPushEndpoint(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	service, ok := h.requireAndroidPush(w)
	if !ok {
		return
	}
	var request registerAndroidPushEndpointRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	endpoint, err := service.RegisterEndpoint(r.Context(), userID, request.DeviceID, request.Endpoint, request.AppVariant)
	if err != nil {
		if strings.Contains(err.Error(), "endpoint") || strings.Contains(err.Error(), "device_id") || strings.Contains(err.Error(), "app_variant") {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		slog.Warn("RegisterAndroidPushEndpoint failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to register Android alerts")
		return
	}
	writeJSON(w, http.StatusOK, endpoint)
}

func (h *Handler) ListAndroidPushEndpoints(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	service, ok := h.requireAndroidPush(w)
	if !ok {
		return
	}
	endpoints, err := service.ListEndpoints(r.Context(), userID)
	if err != nil {
		slog.Warn("ListAndroidPushEndpoints failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list Android alert connections")
		return
	}
	writeJSON(w, http.StatusOK, endpoints)
}

type updateAndroidPushEndpointRequest struct {
	Enabled *bool `json:"enabled"`
}

func (h *Handler) UpdateAndroidPushEndpoint(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	service, ok := h.requireAndroidPush(w)
	if !ok {
		return
	}
	endpointID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "endpoint id")
	if !ok {
		return
	}
	var request updateAndroidPushEndpointRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Enabled == nil {
		writeError(w, http.StatusBadRequest, "enabled is required")
		return
	}
	endpoint, err := service.SetEndpointEnabled(r.Context(), userID, uuidToString(endpointID), *request.Enabled)
	if errors.Is(err, androidpush.ErrEndpointNotFound) {
		writeError(w, http.StatusNotFound, "Android alert connection not found")
		return
	}
	if err != nil {
		slog.Warn("UpdateAndroidPushEndpoint failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update Android alert connection")
		return
	}
	writeJSON(w, http.StatusOK, endpoint)
}

func (h *Handler) DeleteAndroidPushEndpoint(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	service, ok := h.requireAndroidPush(w)
	if !ok {
		return
	}
	endpointID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "endpoint id")
	if !ok {
		return
	}
	err := service.DeleteEndpoint(r.Context(), userID, uuidToString(endpointID))
	if errors.Is(err, androidpush.ErrEndpointNotFound) {
		writeError(w, http.StatusNotFound, "Android alert connection not found")
		return
	}
	if err != nil {
		slog.Warn("DeleteAndroidPushEndpoint failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to revoke Android alert connection")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type revokeAndroidPushDeviceRequest struct {
	DeviceID string `json:"device_id"`
}

// RevokeAndroidPushDevice is the authenticated logout hook. Mobile calls it
// before clearing its session; deleting the endpoint also deletes queued work.
func (h *Handler) RevokeAndroidPushDevice(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	service, ok := h.requireAndroidPush(w)
	if !ok {
		return
	}
	var request revokeAndroidPushDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || strings.TrimSpace(request.DeviceID) == "" {
		writeError(w, http.StatusBadRequest, "device_id is required")
		return
	}
	err := service.RevokeDevice(r.Context(), userID, request.DeviceID)
	if errors.Is(err, androidpush.ErrEndpointNotFound) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		slog.Warn("RevokeAndroidPushDevice failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to revoke Android alert connection")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) GetAndroidPushPreference(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	service, ok := h.requireAndroidPush(w)
	if !ok {
		return
	}
	preference, err := service.GetPreference(r.Context(), ctxWorkspaceID(r.Context()), userID)
	if err != nil {
		slog.Warn("GetAndroidPushPreference failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load Android alert preferences")
		return
	}
	writeJSON(w, http.StatusOK, preference)
}

type patchAndroidPushPreferenceRequest struct {
	Enabled        *bool `json:"enabled"`
	Mentions       *bool `json:"mentions"`
	Assignments    *bool `json:"assignments"`
	ReviewBlockers *bool `json:"review_blockers"`
	Comments       *bool `json:"comments"`
	RoutineUpdates *bool `json:"routine_updates"`
}

func (h *Handler) PatchAndroidPushPreference(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	service, ok := h.requireAndroidPush(w)
	if !ok {
		return
	}
	var request patchAndroidPushPreferenceRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	preference, err := service.PatchPreference(r.Context(), ctxWorkspaceID(r.Context()), userID, androidpush.PreferencePatch{
		Enabled: request.Enabled, Mentions: request.Mentions, Assignments: request.Assignments,
		ReviewBlockers: request.ReviewBlockers, Comments: request.Comments, RoutineUpdates: request.RoutineUpdates,
	})
	if err != nil {
		slog.Warn("PatchAndroidPushPreference failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update Android alert preferences")
		return
	}
	writeJSON(w, http.StatusOK, preference)
}

type testAndroidPushRequest struct {
	DeviceID string `json:"device_id"`
}

func (h *Handler) TestAndroidPush(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	service, ok := h.requireAndroidPush(w)
	if !ok {
		return
	}
	var request testAndroidPushRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || strings.TrimSpace(request.DeviceID) == "" {
		writeError(w, http.StatusBadRequest, "device_id is required")
		return
	}
	result, err := service.SendTest(r.Context(), userID, ctxWorkspaceID(r.Context()), request.DeviceID)
	switch {
	case errors.Is(err, androidpush.ErrEndpointNotFound):
		writeError(w, http.StatusNotFound, "Android alert connection not found")
		return
	case errors.Is(err, androidpush.ErrPreferenceDisabled):
		writeError(w, http.StatusConflict, "Android alerts are disabled for this workspace")
		return
	case err != nil:
		slog.Warn("TestAndroidPush failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusBadGateway, "test notification delivery failed")
		return
	}
	writeJSON(w, http.StatusOK, result)
}
