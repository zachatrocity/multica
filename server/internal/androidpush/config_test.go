package androidpush

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUnauthenticatedPublishingRequiresExplicitOptIn(t *testing.T) {
	for _, tc := range []struct {
		name, opt, token, base, key string
		wantErr, disabled           bool
	}{
		{name: "disabled", disabled: true},
		{name: "token required", base: "https://ntfy.example.com", key: "valid", wantErr: true},
		{name: "false does not opt in", opt: "false", base: "https://ntfy.example.com", key: "valid", wantErr: true},
		{name: "invalid flag does not opt in", opt: "yes", base: "https://ntfy.example.com", key: "valid", wantErr: true},
		{name: "explicit opt in", opt: "true", base: "https://ntfy.example.com", key: "valid"},
		{name: "authenticated default", token: "test-token", base: "https://ntfy.example.com", key: "valid"},
		{name: "token retained with opt in", opt: "true", token: "test-token", base: "https://ntfy.example.com", key: "valid"},
		{name: "opt in still needs base", opt: "true", key: "valid", wantErr: true},
		{name: "opt in still needs encryption", opt: "true", base: "https://ntfy.example.com", wantErr: true},
		{name: "opt in still needs valid encryption", opt: "true", base: "https://ntfy.example.com", key: "invalid", wantErr: true},
		{name: "opt in still needs HTTPS", opt: "true", base: "http://ntfy.example.com", key: "valid", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key := tc.key
			if key == "valid" {
				key = base64.StdEncoding.EncodeToString(make([]byte, 32))
			}
			t.Setenv("MULTICA_NTFY_BASE_URL", tc.base)
			t.Setenv("MULTICA_NTFY_SECRET_KEY", key)
			t.Setenv("MULTICA_NTFY_ACCESS_TOKEN", tc.token)
			t.Setenv("MULTICA_NTFY_ALLOW_UNAUTHENTICATED", tc.opt)
			t.Setenv("MULTICA_NTFY_ALLOW_INSECURE_HTTP", "false")
			s, err := NewFromEnv(&pgxpool.Pool{}, nil)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v, wantErr=%v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if tc.disabled {
				if s != nil {
					t.Fatal("expected disabled service")
				}
				return
			}
			if s == nil || s.accessToken != tc.token {
				t.Fatal("service/token not preserved")
			}
		})
	}
}

func TestDeliveryAuthorizationHeader(t *testing.T) {
	for _, token := range []string{"", "publisher-token"} {
		t.Run("token="+token, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if token == "" {
					if _, ok := r.Header["Authorization"]; ok {
						t.Error("anonymous delivery included Authorization")
					}
				} else if r.Header.Get("Authorization") != "Bearer "+token {
					t.Error("missing publisher token")
				}
				if r.Header.Get("X-Idempotency-Key") != "test-event" {
					t.Error("missing idempotency key")
				}
				if r.Header.Get("Content-Encoding") != "aes128gcm" ||
					r.Header.Get("Content-Type") != "application/octet-stream" ||
					r.Header.Get("TTL") != "86400" {
					t.Errorf("invalid Web Push headers: %v", r.Header)
				}
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error(err)
				}
				if bytes.Contains(body, []byte(`{"version":1}`)) {
					t.Error("delivery body exposed plaintext")
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()
			s := &Service{accessToken: token}
			recipient, err := ecdh.P256().GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			authSecret := make([]byte, webPushAuthSecretSize)
			if _, err := io.ReadFull(rand.Reader, authSecret); err != nil {
				t.Fatal(err)
			}
			req, err := s.deliveryRequest(
				context.Background(),
				mustURL(t, server.URL),
				[]byte(`{"version":1}`),
				recipient.PublicKey().Bytes(),
				authSecret,
				"test-event",
			)
			if err != nil {
				t.Fatal(err)
			}
			res, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
		})
	}
}
