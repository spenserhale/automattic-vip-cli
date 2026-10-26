package commands

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Automattic/vip/internal/auth"
	"github.com/Automattic/vip/internal/keychain"
)

// lockedLogoutBackend behaves like a macOS login keychain that is locked for
// an SSH session: missing items are reported missing, but reading, writing,
// or deleting anything fails the way go-keyring does there.
type lockedLogoutBackend struct{ items map[string]bool }

func (b *lockedLogoutBackend) Get(s, u string) (string, error) {
	if !b.items[s+"|"+u] {
		return "", keychain.ErrNotFound
	}
	return "", errors.New("exit status 36")
}

func (b *lockedLogoutBackend) Set(string, string, string) error {
	return errors.New("exit status 36")
}

func (b *lockedLogoutBackend) Delete(s, u string) error {
	if !b.items[s+"|"+u] {
		return keychain.ErrNotFound
	}
	return errors.New("exit status 36")
}

func TestLogoutCmdReportsLockedKeychainInsteadOfLoggingOut(t *testing.T) {
	t.Setenv("VIP_CLI_TOKEN", "")
	revoked := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		revoked = true
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	k := &keychain.Keychain{
		Backend:       &lockedLogoutBackend{items: map[string]bool{"vip-next-cli|vip-next-cli": true}},
		Service:       "vip-next-cli",
		LegacyService: "vip-go-cli",
	}

	out, err := runLogoutCmd(t, srv, k)

	var storeErr *auth.CredentialStoreError
	if !errors.As(err, &storeErr) {
		t.Fatalf("logout error = %v (%T), want *auth.CredentialStoreError", err, err)
	}
	if !strings.HasPrefix(err.Error(), "unable to remove VIP-CLI credentials from the system keychain: exit status 36;") {
		t.Errorf("logout error = %q", err.Error())
	}
	if strings.Contains(out, "You are now logged out.") {
		t.Errorf("logout claimed success: %q", out)
	}
	if revoked {
		t.Error("logout revoked a token it could not read")
	}
}
