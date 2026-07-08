# Research: Secure token-storage alternatives for SSH / headless sessions

Companion to [bug-ssh-keychain-startup-error.md](./bug-ssh-keychain-startup-error.md). Status: **options for review — nothing implemented yet.**

## Problem

VIP-CLI stores its auth token in the OS keychain (`@github/keytar`). On macOS over SSH the keychain ACL prompt cannot be shown, so token reads fail. We want an **explicitly selectable** alternative backend that keeps the token encrypted at rest but works with no GUI.

This is not a macOS quirk. Every OS-native vault fails headless for the same structural reason: the vault's unlock key is derived from an _interactive_ login (password entry or GUI unlock), and SSH public-key auth never produces that material. macOS Keychain, Windows DPAPI/Credential Manager (fails for pubkey-auth OpenSSH logons — documented git-credential-manager bug), and KWallet (`kwallet-pam` needs a plaintext password at PAM time) all share it. So "make the native vault work over SSH" is best-effort on every platform, and a real fix needs a non-vault backend.

## Requirements

- Token encrypted at rest (better than the existing plaintext `Insecure` configstore fallback).
- Works with no GUI, no D-Bus session, no biometrics.
- Explicit opt-in (flag and/or env var) — **not** a silent fallback. GitHub CLI's silent plaintext fallback is widely criticized (cli/cli#8954); the industry-mature pattern is aws-vault's deliberate `--backend` selection and Zowe's explicit credential-manager override.
- Selection mechanism must work **before argument parsing**: the token read happens before commander runs, so an env var is the primary selector (a flag can be supported by scanning `process.argv` the way `-h`/`-v` already are).
- No new native addons if possible — VIP-CLI also ships as a Node SEA binary, and native `.node` addons must be extracted to a temp file and `process.dlopen()`'d manually. (This also rules out "just swap keytar for `@napi-rs/keyring` / Zowe secrets-sdk" — those modernize the binding but keep the same OS-vault dependency and the same headless failure.)

## Options

### Option 1 — Token via environment variable (bypass storage entirely)

`VIP_CLI_TOKEN=<personal access token>` read at startup, taking precedence over the keychain (precedent: `GH_TOKEN`, `DOPPLER_TOKEN`, `STRIPE_API_KEY`, `OP_SERVICE_ACCOUNT_TOKEN`, npm's `${NPM_TOKEN}` interpolation). VIP-CLI already does exactly this for one flow: `WPVIP_DEPLOY_TOKEN`.

- **Security:** nothing written to disk by us; the user decides where the token lives (shell profile, 1Password `op run`, direnv, CI secret). Exposure risk shifts to env/shell-history hygiene.
- **Headless UX:** perfect — works everywhere, including CI.
- **Effort:** tiny (~20 lines in `Token.get()` / login-flow guards). No new deps.
- **Limitation:** it's a bypass, not storage — the user manages the secret themselves.

### Option 2 — Passphrase-encrypted token file (recommended storage backend)

A new `EncryptedFile` keychain backend: random salt → `scrypt` → AES-256-GCM, all from `node:crypto` (zero new dependencies, no SEA impact, ~40 lines). Passphrase supplied via `VIP_CLI_KEYCHAIN_PASSPHRASE` env var or interactive terminal prompt. Selected via `VIP_CLI_KEYCHAIN=encrypted-file` (env var; optional `--keychain` flag alias later).

Precedent: aws-vault's `file` backend (JWE-encrypted per-credential files + `AWS_VAULT_FILE_PASSPHRASE`), chezmoi's age encryption (+ `AGE_PASSWORD`).

- **Security:** real encryption at rest; an attacker with disk access gets ciphertext and must brute-force the passphrase through scrypt. Caveat shared with aws-vault: if the passphrase itself is exported in the shell profile, anything that can read the env can decrypt — still strictly better than plaintext, and equal to what aws-vault ships.
- **Headless UX:** good. Prompt-per-invocation if no env var; env var makes it silent. (Session caching à la `gpg-agent` TTL would require a small unix-socket agent daemon — explicitly out of MVP scope.)
- **Effort:** small-medium. Fits the existing `Keychain` interface (`getPassword`/`setPassword`/`deletePassword`) cleanly alongside `Secure`/`Insecure`.
- **Variant:** use the `age` format via the `age-encryption` npm package (typage — pure JS, maintained by age's author, supports scrypt passphrase mode) so files are inspectable/recoverable with the standard `age` CLI. Costs one small pure-JS dependency; buys format interoperability for support/debugging. Note typage does **not** support SSH-key recipients (open issue FiloSottile/typage#26).

### Option 3 — GPG / `pass` backend (shell out)

A backend that shells out to [`pass`](https://www.passwordstore.org/) (`pass show/insert vip-cli/token`), the pattern Docker's `pass` credential helper uses on headless Linux.

- **Security:** GPG-grade; key management delegated to the user's GPG setup.
- **Headless UX:** the best caching story for free — `gpg-agent` caches the unlocked key (default 600 s TTL, configurable), so one pinentry unlock covers a whole work session, even over SSH (curses pinentry works in a terminal).
- **Effort:** small wrapper (spawn binary, parse stdout), **but** adds external binary prerequisites (`gpg`, `pass`, initialized key) that most macOS users won't have. The Node npm wrappers (`node-gpg`, `password-store`) are stale — we'd spawn the binaries directly.
- **Fit:** great power-user option, poor default; docs burden is real.

### Option 4 — ssh-agent signature-derived encryption (not recommended)

Encrypt the token to a key derived from a deterministic ssh-agent signature over a fixed challenge (HKDF(signature) → AES key), so a forwarded agent can decrypt over SSH with zero prompts. Implementations: `sshcrypt` (explicitly experimental, "use age instead"), `ssh-tresor`; age core has declined agent support (age#244).

- **Why rejected:** only works with deterministic signature schemes (Ed25519, RSA-PKCS1v15 — never ECDSA), so it breaks depending on which key type the user happens to have; no maintained/audited implementation exists; and agent forwarding silently extends decryption capability to every host the agent is forwarded to. Bespoke crypto for a CLI auth token isn't worth it.

### Option 5 — Make the macOS keychain itself work over SSH (docs-only mitigation)

`security unlock-keychain` + pre-authorizing the binary on the item ACL (`security add-generic-password -T /path/to/node`), possibly `set-key-partition-list`.

- **Why not as a product feature:** field reports (fastlane#19369, Apple dev forums) show headless SSH sessions still hit "User interaction is not allowed" even after correct unlock+ACL setup; `-T` pins a binary _path_, which breaks silently whenever nvm/Homebrew moves `node`; and unlock state is machine-wide, not session-scoped. Worth a **troubleshooting docs section**, not code.

### Option 6 — Explicit opt-in plaintext (`insecure`) backend

The `Insecure` configstore backend already exists in the codebase — expose it deliberately via `VIP_CLI_KEYCHAIN=insecure` (precedent: `gh auth login --insecure-storage`, Azure CLI's `core.encrypt_token_cache=false`, Zowe's credential-manager override). Cheap escape hatch; must warn loudly on use and never engage silently.

## Comparison

| Option                | At-rest security    | Headless UX             | New deps          | SEA impact | Effort | Precedent               |
| --------------------- | ------------------- | ----------------------- | ----------------- | ---------- | ------ | ----------------------- |
| 1. Token env var      | n/a (user-managed)  | ★★★                     | none              | none       | tiny   | gh, Doppler, op, npm    |
| 2. Encrypted file     | strong (scrypt+GCM) | ★★☆ (env var or prompt) | none (or typage)  | none       | small  | aws-vault, chezmoi      |
| 3. GPG / pass         | strong (GPG)        | ★★★ (gpg-agent TTL)     | external binaries | none       | small  | Docker cred helpers     |
| 4. ssh-agent derived  | strong but fragile  | ★★★ when it works       | ssh2 or bespoke   | none       | large  | experimental only       |
| 5. Keychain over SSH  | strong              | ★☆☆ (fragile)           | none              | none       | docs   | fastlane (pain reports) |
| 6. Explicit plaintext | none (chmod 600)    | ★★★                     | none              | none       | tiny   | gh, az, Zowe            |

## Recommendation

Ship **1 + 2 together**, with 6 as a documented escape hatch:

1. **`VIP_CLI_TOKEN` env var** — solves CI and "I just need it to work over SSH right now" with near-zero code.
2. **`VIP_CLI_KEYCHAIN=encrypted-file` + `VIP_CLI_KEYCHAIN_PASSPHRASE`** — the real storage alternative: encrypted at rest, zero new native deps, SEA-safe, mirrors aws-vault's proven design. Plain `node:crypto` construction for MVP; consider the age-format variant if `age`-CLI interoperability is judged worth one pure-JS dependency.
3. **Never fall back silently.** When the secure keychain fails, keep the current behavior from this branch (actionable error) and have the error message name the two supported alternatives.

Option 3 (pass/GPG) is a reasonable fast-follow for power users; options 4 and 5 should not be built.

## Sources

- aws-vault backends: https://github.com/99designs/aws-vault/blob/master/USAGE.md
- gh auth / silent-fallback criticism: https://cli.github.com/manual/gh_auth_login, https://github.com/cli/cli/issues/8954, https://github.com/cli/cli/issues/10108
- 1Password service accounts: https://developer.1password.com/docs/service-accounts/get-started/
- Docker credential helpers: https://github.com/docker/docker-credential-helpers
- Zowe headless SCS docs (closest keytar precedent): https://docs.zowe.org/stable/user-guide/cli-configure-scs-on-headless-linux-os/, https://docs.zowe.org/stable/user-guide/cli-configure-cli-on-os-where-scs-unavailable/
- chezmoi age encryption: https://www.chezmoi.io/user-guide/encryption/age/
- typage (age in JS): https://github.com/FiloSottile/typage, SSH-recipient gap: https://github.com/FiloSottile/typage/issues/26
- age ssh-agent discussion: https://github.com/FiloSottile/age/discussions/244; sshcrypt: https://github.com/leighmcculloch/sshcrypt; ssh-tresor: https://github.com/haraldh/ssh-tresor
- macOS keychain-over-SSH fragility: https://github.com/fastlane/fastlane/issues/19369, https://developer.apple.com/forums/thread/666107
- Windows DPAPI over SSH failure: https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/credstores.md, https://github.com/GitCredentialManager/git-credential-manager/issues/666
- gnome-keyring headless: https://wiki.archlinux.org/title/GNOME/Keyring
- gpg-agent caching: https://www.gnupg.org/documentation/manuals/gnupg/Agent-Options.html
- Node SEA assets/native addons: https://nodejs.org/api/single-executable-applications.html
