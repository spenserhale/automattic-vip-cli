package auth

import "fmt"

// credentialOp names what the Store was doing when the credential store failed.
type credentialOp string

const (
	credentialRead   credentialOp = "read VIP-CLI credentials from"
	credentialSave   credentialOp = "save VIP-CLI credentials to"
	credentialRemove credentialOp = "remove VIP-CLI credentials from"
)

// CredentialStoreError reports that the credential store refused an operation
// on a stored credential for a reason other than the credential being absent.
//
// On macOS over SSH the login keychain is locked for the session and cannot
// show an authorization prompt, so the security tool behind go-keyring exits
// with status 36 and the bare exec error says nothing about why. The Node CLI
// reports the same failures with KeychainError in src/lib/token.ts.
type CredentialStoreError struct {
	Op  credentialOp
	Err error
}

func (e *CredentialStoreError) Error() string {
	remedy := fmt.Sprintf("run VIP-CLI from a local graphical session, unlock the keychain, or set %s to a Personal Access Token from %s", EnvironmentTokenName, TokenURL)
	if e.Op == credentialRemove {
		remedy = "run VIP-CLI from a local graphical session, or unlock the keychain"
	}
	return fmt.Sprintf("unable to %s the system keychain: %v; if you are connected over SSH or another non-graphical session, the keychain may be locked or unable to show an authorization prompt; %s", e.Op, e.Err, remedy)
}

func (e *CredentialStoreError) Unwrap() error { return e.Err }

// credentialStoreError wraps err, leaving nil alone so call sites can pass any
// backend result through.
func credentialStoreError(op credentialOp, err error) error {
	if err == nil {
		return nil
	}
	return &CredentialStoreError{Op: op, Err: err}
}
