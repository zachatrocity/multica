package androidpush

import (
	"encoding/json"
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

func TestNotificationDisplayUsesCompactPrivateCopy(t *testing.T) {
	delivery := claimedDelivery{
		EventType:     "mentioned",
		EventCategory: string(CategoryMentions),
		EventBody:     "Please review **this** [link](https://example.com/private) before shipping.",
	}
	copy := notificationDisplay(delivery, notificationContext{
		WorkspaceName: "Mobile",
		IssueRef:      "SWE-88",
		IssueTitle:    "Android notification support",
		ActorName:     "Zach",
	})
	if copy.Title != "Zach mentioned you" || copy.Channel != "action_needed" {
		t.Fatalf("copy = %+v", copy)
	}
	if copy.Body != "SWE-88 · Android notification support" {
		t.Fatalf("body = %q", copy.Body)
	}
	if copy.ExpandedBody != "SWE-88 · Android notification support · Mobile\n“Please review this link before shipping.”" {
		t.Fatalf("expanded body = %q", copy.ExpandedBody)
	}
}
func TestNotificationDisplayFormatsAssignmentsWithoutRepeatingIssueReference(t *testing.T) {
	copy := notificationDisplay(claimedDelivery{
		EventType:     "issue_assigned",
		EventCategory: string(CategoryAssignments),
	}, notificationContext{
		WorkspaceName: "Acme Ops",
		IssueRef:      "SWE-88",
		IssueTitle:    "Add Android alerts",
	})
	if copy.Title != "SWE-88 assigned to you" ||
		copy.Body != "Add Android alerts · Acme Ops" ||
		copy.Channel != "action_needed" {
		t.Fatalf("copy = %+v", copy)
	}
}

func TestNotificationDisplaySeparatesRoutineStatusUpdates(t *testing.T) {
	details, err := json.Marshal(map[string]string{"to": "in_progress"})
	if err != nil {
		t.Fatal(err)
	}
	copy := notificationDisplay(claimedDelivery{
		EventType:     "status_changed",
		EventCategory: string(CategoryRoutineUpdates),
		EventDetails:  details,
	}, notificationContext{
		WorkspaceName: "Mobile",
		IssueRef:      "SWE-88",
		IssueTitle:    "Android notification support",
	})
	if copy.Title != "SWE-88 moved to in progress" || copy.Channel != "activity" {
		t.Fatalf("copy = %+v", copy)
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
