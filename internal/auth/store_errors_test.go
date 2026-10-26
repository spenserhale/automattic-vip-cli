package auth

import (
	"errors"
	"strings"
	"testing"

	"github.com/Automattic/vip/internal/keychain"
)

// errLocked is what go-keyring returns on macOS over SSH: the security tool
// exits with status 36 and its explanation is discarded.
var errLocked = errors.New("exit status 36")

// lockedBackend behaves like a macOS login keychain that is locked for the
// session: looking up a missing item still reports it missing, but reading,
// writing, or deleting anything needs an authorization prompt and fails.
type lockedBackend struct{ items map[string]bool }

func (b *lockedBackend) Get(s, u string) (string, error) {
	if !b.items[s+"|"+u] {
		return "", keychain.ErrNotFound
	}
	return "", errLocked
}

func (b *lockedBackend) Set(string, string, string) error { return errLocked }

func (b *lockedBackend) Delete(s, u string) error {
	if !b.items[s+"|"+u] {
		return keychain.ErrNotFound
	}
	return errLocked
}

func newLockedStore(items ...string) *Store {
	present := map[string]bool{}
	for _, item := range items {
		present[item] = true
	}
	return NewStore(&keychain.Keychain{
		Backend:       &lockedBackend{items: present},
		Service:       "vip-next-cli",
		LegacyService: "vip-go-cli",
	})
}

func requireCredentialStoreError(t *testing.T, err error, op credentialOp) *CredentialStoreError {
	t.Helper()
	var storeErr *CredentialStoreError
	if !errors.As(err, &storeErr) {
		t.Fatalf("error = %v (%T), want *CredentialStoreError", err, err)
	}
	if storeErr.Op != op {
		t.Errorf("Op = %q, want %q", storeErr.Op, op)
	}
	if !errors.Is(err, errLocked) {
		t.Errorf("error does not wrap the backend error: %v", err)
	}
	for _, want := range []string{"exit status 36", "SSH", "unlock the keychain"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err.Error(), want)
		}
	}
	return storeErr
}

func TestResolveExplainsLockedKeychainForLegacyNodeLogin(t *testing.T) {
	t.Setenv(EnvironmentTokenName, "")
	// Logged in with the Node CLI only, so vip-next falls back to its token.
	s := newLockedStore("vip-go-cli|vip-go-cli")

	_, err := s.Resolve()

	requireCredentialStoreError(t, err, credentialRead)
	if !strings.HasPrefix(err.Error(), "unable to read VIP-CLI credentials from the system keychain: exit status 36;") {
		t.Errorf("error = %q", err.Error())
	}
	if !strings.Contains(err.Error(), "set VIP_CLI_TOKEN") {
		t.Errorf("error %q does not suggest VIP_CLI_TOKEN", err.Error())
	}
}

func TestResolveExplainsLockedKeychainForPrimaryLogin(t *testing.T) {
	t.Setenv(EnvironmentTokenName, "")
	s := newLockedStore("vip-next-cli|vip-next-cli")

	_, err := s.Resolve()

	requireCredentialStoreError(t, err, credentialRead)
	if strings.Count(err.Error(), "unable to read") != 1 {
		t.Errorf("error is wrapped more than once: %q", err.Error())
	}
}

func TestResolveWithoutAnyStoredTokenIsNotAKeychainError(t *testing.T) {
	t.Setenv(EnvironmentTokenName, "")
	s := newLockedStore()

	if _, err := s.Resolve(); !errors.Is(err, ErrNoToken) {
		t.Fatalf("Resolve error = %v, want ErrNoToken", err)
	}
}

func TestSaveExplainsLockedKeychain(t *testing.T) {
	err := newLockedStore().Save("jwt.payload.sig")

	requireCredentialStoreError(t, err, credentialSave)
	if !strings.Contains(err.Error(), "set VIP_CLI_TOKEN") {
		t.Errorf("error %q does not suggest VIP_CLI_TOKEN", err.Error())
	}
}

func TestDeleteExplainsLockedKeychain(t *testing.T) {
	err := newLockedStore("vip-next-cli|vip-next-cli").Delete()

	requireCredentialStoreError(t, err, credentialRemove)
	if strings.Contains(err.Error(), "VIP_CLI_TOKEN") {
		t.Errorf("logout cannot be fixed with VIP_CLI_TOKEN, but the error suggests it: %q", err.Error())
	}
}

func TestDeleteExplainsLockedKeychainWhenOnlyTheFallbackMarkerFails(t *testing.T) {
	// No vip-next token to delete, but disabling the legacy fallback is a write.
	err := newLockedStore().Delete()

	requireCredentialStoreError(t, err, credentialRemove)
}
