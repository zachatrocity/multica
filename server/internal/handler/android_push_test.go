package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/androidpush"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func setupAndroidPushTest(t *testing.T, publish http.Handler) (*androidpush.Service, *httptest.Server) {
	t.Helper()
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	server := httptest.NewServer(publish)
	service, err := androidpush.New(testPool, androidpush.Config{
		BaseURL: server.URL, AccessToken: "test-publisher-token",
		Key: bytes.Repeat([]byte{0xA5}, 32), AllowInsecureHTTP: true,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	previous := testHandler.AndroidPush
	testHandler.AndroidPush = service
	_, _ = testPool.Exec(context.Background(), `DELETE FROM android_push_delivery WHERE endpoint_id IN (SELECT id FROM android_push_endpoint WHERE user_id = $1)`, testUserID)
	_, _ = testPool.Exec(context.Background(), `DELETE FROM android_push_endpoint WHERE user_id = $1`, testUserID)
	_, _ = testPool.Exec(context.Background(), `DELETE FROM android_push_preference WHERE user_id = $1`, testUserID)
	t.Cleanup(func() {
		testHandler.AndroidPush = previous
		_, _ = testPool.Exec(context.Background(), `DELETE FROM android_push_delivery WHERE endpoint_id IN (SELECT id FROM android_push_endpoint WHERE user_id = $1)`, testUserID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM android_push_endpoint WHERE user_id = $1`, testUserID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM android_push_preference WHERE user_id = $1`, testUserID)
		server.Close()
	})
	return service, server
}

func TestAndroidPushEndpointLifecycleIsScopedAndSecret(t *testing.T) {
	service, server := setupAndroidPushTest(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	register := func(endpoint string) (androidpush.Endpoint, string) {
		t.Helper()
		recorder := httptest.NewRecorder()
		testHandler.RegisterAndroidPushEndpoint(recorder, newRequest(http.MethodPost, "/api/android-push/endpoints", map[string]any{
			"device_id": "device-one", "endpoint": endpoint, "app_variant": "production",
		}))
		if recorder.Code != http.StatusOK {
			t.Fatalf("register status=%d body=%s", recorder.Code, recorder.Body.String())
		}
		var response androidpush.Endpoint
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response, recorder.Body.String()
	}

	first, firstBody := register(server.URL + "/up/first-secret")
	if strings.Contains(firstBody, "first-secret") || strings.Contains(firstBody, server.URL) {
		t.Fatalf("registration response exposed endpoint: %s", firstBody)
	}
	var ciphertext []byte
	if err := testPool.QueryRow(context.Background(), `SELECT endpoint_encrypted FROM android_push_endpoint WHERE id = $1`, first.ID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("first-secret")) {
		t.Fatal("endpoint was stored in plaintext")
	}

	rotated, rotatedBody := register(server.URL + "/up/rotated-secret")
	if rotated.ID != first.ID {
		t.Fatalf("rotation created a second device endpoint: first=%s rotated=%s", first.ID, rotated.ID)
	}
	if strings.Contains(rotatedBody, "rotated-secret") {
		t.Fatalf("rotation response exposed endpoint: %s", rotatedBody)
	}
	if count := countRows(t, `SELECT count(*) FROM android_push_endpoint WHERE user_id = $1 AND device_id = 'device-one'`, testUserID); count != 1 {
		t.Fatalf("device endpoint count=%d, want 1", count)
	}

	otherUser := uuid.NewString()
	foreignDelete := withURLParam(newRequestAs(otherUser, http.MethodDelete, "/api/android-push/endpoints/"+first.ID, nil), "id", first.ID)
	foreignRecorder := httptest.NewRecorder()
	testHandler.DeleteAndroidPushEndpoint(foreignRecorder, foreignDelete)
	if foreignRecorder.Code != http.StatusNotFound {
		t.Fatalf("foreign delete status=%d body=%s", foreignRecorder.Code, foreignRecorder.Body.String())
	}

	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO android_push_delivery (endpoint_id, event_id, workspace_id, event_type)
		VALUES ($1, $2, $3, 'test')`, first.ID, uuid.NewString(), testWorkspaceID); err != nil {
		t.Fatal(err)
	}
	disableRecorder := httptest.NewRecorder()
	testHandler.UpdateAndroidPushEndpoint(disableRecorder,
		withURLParam(newRequest(http.MethodPatch, "/api/android-push/endpoints/"+first.ID, map[string]any{"enabled": false}), "id", first.ID))
	if disableRecorder.Code != http.StatusOK || !strings.Contains(disableRecorder.Body.String(), `"status":"disabled"`) {
		t.Fatalf("disable status=%d body=%s", disableRecorder.Code, disableRecorder.Body.String())
	}
	if count := countRows(t, `SELECT count(*) FROM android_push_delivery WHERE endpoint_id=$1 AND status IN ('pending', 'retry', 'delivering')`, first.ID); count != 0 {
		t.Fatalf("queued delivery survived endpoint disable: count=%d", count)
	}

	if _, err := testPool.Exec(context.Background(), `UPDATE android_push_endpoint SET status='active', disabled_at=NULL, expires_at=now()-interval '1 second' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.Cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := testPool.QueryRow(context.Background(), `SELECT status FROM android_push_endpoint WHERE id=$1`, first.ID).Scan(&status); err != nil || status != "disabled" {
		t.Fatalf("expired endpoint status=%q err=%v", status, err)
	}

	revokeRecorder := httptest.NewRecorder()
	testHandler.RevokeAndroidPushDevice(revokeRecorder, newRequest(http.MethodPost, "/api/android-push/endpoints/revoke-device", map[string]any{"device_id": "device-one"}))
	if revokeRecorder.Code != http.StatusNoContent {
		t.Fatalf("revoke status=%d body=%s", revokeRecorder.Code, revokeRecorder.Body.String())
	}
	if count := countRows(t, `SELECT count(*) FROM android_push_endpoint WHERE id=$1`, first.ID); count != 0 {
		t.Fatalf("endpoint survived logout revocation: count=%d", count)
	}
}

func TestAndroidPushPreferencesAreWorkspaceScopedAndTestUsesTransport(t *testing.T) {
	var requestCount int
	var authorization, idempotency string
	var received map[string]any
	service, server := setupAndroidPushTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		authorization = r.Header.Get("Authorization")
		idempotency = r.Header.Get("X-Idempotency-Key")
		_ = json.NewDecoder(r.Body).Decode(&received)
		w.WriteHeader(http.StatusNoContent)
	}))
	if _, err := service.RegisterEndpoint(context.Background(), testUserID, "device-two", server.URL+"/up/device-secret", "production"); err != nil {
		t.Fatal(err)
	}
	enabled := true
	preference, err := service.PatchPreference(context.Background(), testWorkspaceID, testUserID, androidpush.PreferencePatch{Enabled: &enabled})
	if err != nil || !preference.Enabled || !preference.Mentions || !preference.Assignments || !preference.ReviewBlockers || preference.Comments || preference.RoutineUpdates {
		t.Fatalf("enabled preference=%+v err=%v", preference, err)
	}
	otherWorkspace := uuid.NewString()
	otherPreference, err := service.GetPreference(context.Background(), otherWorkspace, testUserID)
	if err != nil || otherPreference.Enabled {
		t.Fatalf("other workspace preference=%+v err=%v", otherPreference, err)
	}

	member, err := testHandler.Queries.GetMemberByUserAndWorkspace(context.Background(), db.GetMemberByUserAndWorkspaceParams{
		UserID: parseUUID(testUserID), WorkspaceID: parseUUID(testWorkspaceID),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := newRequest(http.MethodPost, "/api/android-push/test", map[string]any{"device_id": "device-two"})
	request = request.WithContext(middleware.SetMemberContext(request.Context(), testWorkspaceID, member))
	recorder := httptest.NewRecorder()
	testHandler.TestAndroidPush(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("test status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if requestCount != 1 || authorization != "Bearer test-publisher-token" || idempotency == "" {
		t.Fatalf("transport requests=%d authorization=%q idempotency=%q", requestCount, authorization, idempotency)
	}
	if received["version"] != float64(1) || received["event_id"] != idempotency || received["event_type"] != "test" || received["workspace_id"] != testWorkspaceID {
		t.Fatalf("test payload=%#v", received)
	}
	for _, forbidden := range []string{"endpoint", "title", "body", "url"} {
		if _, exists := received[forbidden]; exists {
			t.Fatalf("test payload exposed %s: %#v", forbidden, received)
		}
	}
}

func countRows(t *testing.T, query string, args ...any) int {
	t.Helper()
	var count int
	if err := testPool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
