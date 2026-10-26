package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/Automattic/vip/internal/auth"
)

// Over SSH on macOS go-keyring reports a locked keychain only as the security
// tool's exit status. The session bootstrap must explain it instead.
func TestWithAuthenticatedSessionExplainsLockedKeychain(t *testing.T) {
	t.Setenv("VIP_CLI_TOKEN", "")
	k := newBootstrapKeychain(&bootstrapBackend{getErr: errors.New("exit status 36")})

	err := withAuthenticatedSession(true, authBootstrapDeps{
		Keychain: k,
		Store:    auth.NewStore(k),
		Login: func() (*auth.Token, error) {
			t.Fatal("login must not start when the keychain cannot be read")
			return nil, nil
		},
	}, func(*authSession) error {
		t.Fatal("the command must not run without a credential")
		return nil
	})

	var storeErr *auth.CredentialStoreError
	if !errors.As(err, &storeErr) {
		t.Fatalf("error = %v (%T), want *auth.CredentialStoreError", err, err)
	}
	for _, want := range []string{
		"unable to read VIP-CLI credentials from the system keychain: exit status 36",
		"SSH",
		"set VIP_CLI_TOKEN",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err.Error(), want)
		}
	}
}
