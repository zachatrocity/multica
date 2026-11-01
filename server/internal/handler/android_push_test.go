package handler

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/androidpush"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
		keys := newTestWebPushKeys(t)
		recorder := httptest.NewRecorder()
		testHandler.RegisterAndroidPushEndpoint(recorder, newRequest(http.MethodPost, "/api/android-push/endpoints", map[string]any{
			"device_id": "device-one", "endpoint": endpoint, "p256dh": keys.p256dh,
			"auth": keys.auth, "app_variant": "production",
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
	var endpointCiphertext, publicKeyCiphertext, authCiphertext []byte
	if err := testPool.QueryRow(context.Background(), `
		SELECT endpoint_encrypted, p256dh_encrypted, auth_encrypted
		FROM android_push_endpoint WHERE id = $1`, first.ID).
		Scan(&endpointCiphertext, &publicKeyCiphertext, &authCiphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(endpointCiphertext, []byte("first-secret")) ||
		bytes.Contains(publicKeyCiphertext, []byte("first-secret")) ||
		bytes.Contains(authCiphertext, []byte("first-secret")) {
		t.Fatal("registration material was stored in plaintext")
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
	var authorization, idempotency, contentEncoding, contentType, ttl string
	var encryptedBody []byte
	service, server := setupAndroidPushTest(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		authorization = r.Header.Get("Authorization")
		idempotency = r.Header.Get("X-Idempotency-Key")
		contentEncoding = r.Header.Get("Content-Encoding")
		contentType = r.Header.Get("Content-Type")
		ttl = r.Header.Get("TTL")
		encryptedBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	keys := newTestWebPushKeys(t)
	if _, err := service.RegisterEndpoint(context.Background(), testUserID, androidpush.Registration{
		DeviceID: "device-two", Endpoint: server.URL + "/up/device-secret",
		P256DH: keys.p256dh, Auth: keys.auth, AppVariant: "production",
	}); err != nil {
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
	if contentEncoding != "aes128gcm" || contentType != "application/octet-stream" || ttl != "86400" {
		t.Fatalf("Web Push headers encoding=%q type=%q ttl=%q", contentEncoding, contentType, ttl)
	}
	plaintext := decryptTestWebPush(t, keys, encryptedBody)
	var received map[string]any
	if err := json.Unmarshal(plaintext, &received); err != nil {
		t.Fatal(err)
	}
	if received["version"] != float64(1) || received["event_id"] != idempotency || received["event_type"] != "test" || received["workspace_id"] != testWorkspaceID {
		t.Fatalf("test payload=%#v", received)
	}
	for _, forbidden := range []string{"endpoint", "url"} {
		if _, exists := received[forbidden]; exists {
			t.Fatalf("test payload exposed %s: %#v", forbidden, received)
		}
	}

	rotatedKeys := newTestWebPushKeys(t)
	if _, err := service.RegisterEndpoint(context.Background(), testUserID, androidpush.Registration{
		DeviceID: "device-two", Endpoint: server.URL + "/up/device-secret",
		P256DH: rotatedKeys.p256dh, Auth: rotatedKeys.auth, AppVariant: "production",
	}); err != nil {
		t.Fatal(err)
	}
	rotatedRequest := newRequest(http.MethodPost, "/api/android-push/test", map[string]any{"device_id": "device-two"})
	rotatedRequest = rotatedRequest.WithContext(middleware.SetMemberContext(rotatedRequest.Context(), testWorkspaceID, member))
	rotatedRecorder := httptest.NewRecorder()
	testHandler.TestAndroidPush(rotatedRecorder, rotatedRequest)
	if rotatedRecorder.Code != http.StatusOK || requestCount != 2 {
		t.Fatalf("rotated test status=%d body=%s requests=%d", rotatedRecorder.Code, rotatedRecorder.Body.String(), requestCount)
	}
	var rotatedPayload map[string]any
	if err := json.Unmarshal(decryptTestWebPush(t, rotatedKeys, encryptedBody), &rotatedPayload); err != nil {
		t.Fatal(err)
	}
	if rotatedPayload["event_id"] != idempotency || rotatedPayload["event_type"] != "test" {
		t.Fatalf("rotated payload=%#v", rotatedPayload)
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

type testWebPushKeys struct {
	private    *ecdh.PrivateKey
	public     []byte
	authSecret []byte
	p256dh     string
	auth       string
}

func newTestWebPushKeys(t *testing.T) testWebPushKeys {
	t.Helper()
	private, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	authSecret := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, authSecret); err != nil {
		t.Fatal(err)
	}
	public := private.PublicKey().Bytes()
	return testWebPushKeys{
		private: private, public: public, authSecret: authSecret,
		p256dh: base64.RawURLEncoding.EncodeToString(public),
		auth:   base64.RawURLEncoding.EncodeToString(authSecret),
	}
}

func decryptTestWebPush(t *testing.T, keys testWebPushKeys, body []byte) []byte {
	t.Helper()
	if len(body) < 21 {
		t.Fatal("encrypted Web Push body is missing its header")
	}
	keyIDLength := int(body[20])
	headerLength := 21 + keyIDLength
	if keyIDLength != 65 || len(body) <= headerLength {
		t.Fatal("encrypted Web Push body has an invalid sender key")
	}
	senderPublic, err := ecdh.P256().NewPublicKey(body[21:headerLength])
	if err != nil {
		t.Fatal(err)
	}
	sharedSecret, err := keys.private.ECDH(senderPublic)
	if err != nil {
		t.Fatal(err)
	}
	keyInfo := append([]byte("WebPush: info\x00"), keys.public...)
	keyInfo = append(keyInfo, body[21:headerLength]...)
	ikm := testHKDFExpand(testHKDFExtract(keys.authSecret, sharedSecret), keyInfo, 32)
	prk := testHKDFExtract(body[:16], ikm)
	contentKey := testHKDFExpand(prk, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := testHKDFExpand(prk, []byte("Content-Encoding: nonce\x00"), 12)
	block, err := aes.NewCipher(contentKey)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	recordSize := int(binary.BigEndian.Uint32(body[16:20]))
	if recordSize != len(body)-headerLength {
		t.Fatalf("record size=%d, ciphertext=%d", recordSize, len(body)-headerLength)
	}
	record, err := gcm.Open(nil, nonce, body[headerLength:], nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(record) == 0 || record[len(record)-1] != 2 {
		t.Fatal("Web Push record is missing its final delimiter")
	}
	return record[:len(record)-1]
}

func testHKDFExtract(salt, input []byte) []byte {
	mac := hmac.New(sha256.New, salt)
	_, _ = mac.Write(input)
	return mac.Sum(nil)
}

func testHKDFExpand(key, info []byte, length int) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(info)
	_, _ = mac.Write([]byte{1})
	return mac.Sum(nil)[:length]
}
