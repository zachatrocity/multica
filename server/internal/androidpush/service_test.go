package androidpush

import (
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestEndpointAllowedRejectsOtherOriginsAndPathPrefixes(t *testing.T) {
	service := &Service{baseURL: mustURL(t, "https://ntfy.example.com/up")}
	for _, tc := range []struct {
		endpoint string
		allowed  bool
	}{
		{"https://ntfy.example.com/up/device-secret", true},
		{"https://ntfy.example.com/up?token=secret", true},
		{"https://ntfy.example.com/upstream/device-secret", false},
		{"https://other.example.com/up/device-secret", false},
		{"http://ntfy.example.com/up/device-secret", false},
	} {
		_, err := service.endpointAllowed(tc.endpoint)
		if (err == nil) != tc.allowed {
			t.Errorf("endpoint %q allowed=%t, error=%v", tc.endpoint, tc.allowed, err)
		}
	}
}

func TestClassifyDeliveryQuarantinesInvalidCredentials(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		outcome := classifyDelivery(&http.Response{StatusCode: status}, nil)
		if !outcome.Quarantine || outcome.Retry || outcome.Code != "authorization_failed" {
			t.Fatalf("status %d outcome = %+v", status, outcome)
		}
	}
	outcome := classifyDelivery(&http.Response{StatusCode: http.StatusServiceUnavailable}, nil)
	if !outcome.Retry || outcome.Quarantine {
		t.Fatalf("503 outcome = %+v", outcome)
	}
}

func TestRetryDelayIsBounded(t *testing.T) {
	if retryDelay(1) != time.Minute || retryDelay(100) != 8*time.Hour {
		t.Fatalf("retry delays: first=%s final=%s", retryDelay(1), retryDelay(100))
	}
}

func mustURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
