package androidpush

import (
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
)

const (
	defaultEndpointTTL  = 90 * 24 * time.Hour
	defaultPollInterval = 2 * time.Second
)

var ErrNotConfigured = errors.New("android push is not configured")

// Config is the server-owned ntfy publisher contract. BaseURL is an origin and
// optional path prefix; registered UnifiedPush endpoints must remain below it.
type Config struct {
	BaseURL              string
	AccessToken          string
	Key                  []byte
	AllowInsecureHTTP    bool
	AllowUnauthenticated bool
	HTTPClient           *http.Client
	PollInterval         time.Duration
	EndpointTTL          time.Duration
}

// NewFromEnv returns nil when Android push is intentionally unconfigured. A
// partial configuration is rejected so operators do not get a connection UI
// backed by plaintext subscription material or unintentionally unauthenticated publishing.
func NewFromEnv(pool *pgxpool.Pool, logger *slog.Logger) (*Service, error) {
	baseURL := strings.TrimSpace(os.Getenv("MULTICA_NTFY_BASE_URL"))
	accessToken := strings.TrimSpace(os.Getenv("MULTICA_NTFY_ACCESS_TOKEN"))
	keyText := strings.TrimSpace(os.Getenv("MULTICA_NTFY_SECRET_KEY"))
	allowUnauthenticated := strings.EqualFold(strings.TrimSpace(os.Getenv("MULTICA_NTFY_ALLOW_UNAUTHENTICATED")), "true")
	if baseURL == "" && accessToken == "" && keyText == "" && !allowUnauthenticated {
		return nil, nil
	}
	if baseURL == "" || keyText == "" || (accessToken == "" && !allowUnauthenticated) {
		return nil, fmt.Errorf("MULTICA_NTFY_BASE_URL and MULTICA_NTFY_SECRET_KEY are required; set MULTICA_NTFY_ACCESS_TOKEN or explicitly set MULTICA_NTFY_ALLOW_UNAUTHENTICATED=true")
	}
	key, err := secretbox.LoadKey("MULTICA_NTFY_SECRET_KEY")
	if err != nil {
		return nil, fmt.Errorf("MULTICA_NTFY_SECRET_KEY: %w", err)
	}
	allowHTTP := strings.EqualFold(strings.TrimSpace(os.Getenv("MULTICA_NTFY_ALLOW_INSECURE_HTTP")), "true")
	return New(pool, Config{
		BaseURL:              baseURL,
		AccessToken:          accessToken,
		Key:                  key,
		AllowInsecureHTTP:    allowHTTP,
		AllowUnauthenticated: allowUnauthenticated,
	}, logger)
}

func New(pool *pgxpool.Pool, cfg Config, logger *slog.Logger) (*Service, error) {
	if pool == nil {
		return nil, errors.New("android push requires a database pool")
	}
	base, err := url.Parse(strings.TrimSpace(cfg.BaseURL))
	if err != nil || base.Host == "" || (base.Scheme != "https" && base.Scheme != "http") {
		return nil, errors.New("ntfy base URL must be an absolute HTTP(S) URL")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("ntfy base URL must not contain credentials, a query, or a fragment")
	}
	if base.Scheme != "https" && !cfg.AllowInsecureHTTP {
		return nil, errors.New("ntfy base URL must use HTTPS unless MULTICA_NTFY_ALLOW_INSECURE_HTTP=true")
	}
	if strings.TrimSpace(cfg.AccessToken) == "" && !cfg.AllowUnauthenticated {
		return nil, errors.New("ntfy access token is required")
	}
	box, err := secretbox.New(cfg.Key)
	if err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 8 * time.Second}
	}
	poll := cfg.PollInterval
	if poll <= 0 {
		poll = defaultPollInterval
	}
	ttl := cfg.EndpointTTL
	if ttl <= 0 {
		ttl = defaultEndpointTTL
	}
	hashKeyMAC := hmac.New(sha256.New, cfg.Key)
	_, _ = hashKeyMAC.Write([]byte("multica/android-push-endpoint/v1"))
	return &Service{
		pool:         pool,
		baseURL:      base,
		accessToken:  strings.TrimSpace(cfg.AccessToken),
		box:          box,
		hashKey:      hashKeyMAC.Sum(nil),
		httpClient:   client,
		logger:       logger,
		pollInterval: poll,
		endpointTTL:  ttl,
		wake:         make(chan struct{}, 1),
	}, nil
}
