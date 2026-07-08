# Bug: VIP-CLI fails with "Unexpected error" when run over SSH on macOS

## Summary

Running any `vip` command (even `vip -h`) in an SSH session on a macOS machine fails at startup with a generic, undiagnosable error — while the same command works fine in a local (graphical) session on the same machine.

## Reproduction

1. On machine A, `ssh` into a macOS machine B that has VIP-CLI installed and previously authenticated.
2. Run `vip -h` on machine B via the SSH session.

Observed output:

```
✕ Please contact VIP Support with the following information:
Error: An unknown error occurred.
Error:  Unexpected error
Debug:  VIP-CLI v4.0.10, Node v26.4.0, darwin 24.6.0 arm64, Runtime node-script
```

Running `vip -h` directly on machine B (local terminal) works fine.

## Root cause

Chain of events (line numbers refer to the code as of v4.0.10):

1. `src/bin/vip.js` — `rootCmd()` calls `Token.get()` unconditionally at startup (line ~196), BEFORE checking whether the invocation is `-h`/`--help`/`-v`/`--version` (which don't need auth). So even `vip -h` requires a successful keychain read.

2. `src/lib/keychain.ts` — `getKeychain()` decides between the Secure (OS keychain via `@github/keytar`) and Insecure (plaintext configstore) backends by probing `getPassword()` for a deliberately NON-EXISTENT service name. On macOS, looking up a non-existent keychain item returns "item not found" (resolves to `null`, no error) even in an SSH session — so the Secure backend is selected.

3. Reading the REAL `vip-go-cli` keychain item, however, requires keychain ACL authorization, which macOS grants via a GUI prompt. In an SSH session there is no GUI, so the macOS Security framework rejects with the raw error message "An unknown error occurred." — a native N-API rejection with no useful stack frames.

4. Nothing catches the rejection: `Token.get()` doesn't, and `rootCmd()` is invoked as `void rootCmd()` (`src/bin/vip.js` line ~244). It surfaces as an `unhandledRejection`, handled by `uncaughtError()` in `src/lib/cli/command.js` (line ~22), which prints the generic "Please contact VIP Support" message.

## Why it was hard to diagnose

- The crash happens before commander parses arguments, so `--debug` (or any flag) can't change the output.
- The keytar/Security-framework error carries no stack frames, so the printed "stack" is just the bare message.
- The probe-then-trust design in `getKeychain()` masks the fact that the secure keychain is only _partially_ usable in the session.

## Fix (this branch)

1. `src/bin/vip.js`: compute the "does this invocation need a token?" flags BEFORE fetching the token, and skip the keychain read entirely for help/version/logout/dev-env(no env)/custom-deploy invocations — so `vip -h` and `vip -v` now work over SSH. When a token IS needed, `Token.get()` is wrapped in a try/catch that prints an actionable error (keychain locked/unavailable, common over SSH, with remediation hints) instead of an opaque crash.

2. `src/lib/cli/command.js`: the top-level `uncaughtException`/`unhandledRejection` handler now prints the full error details (message, code, stack, inspected properties) plus environment info, and tells the user they can re-run with `DEBUG=@automattic/vip:*` (an env var works even when the crash precedes argument parsing).

## Alternatives considered

- Falling back to the Insecure keychain when a Secure read fails: rejected because it would create split credential state (SSH sessions writing plaintext tokens while local sessions use the OS keychain) and silently downgrade security.
- Probing `getKeychain()` with the real service name: would detect the ACL failure, but has the same silent-fallback downside.

## Workaround for users (older versions)

Run vip in a local/graphical session, or pre-authorize/unlock the keychain in the SSH session (e.g. `security unlock-keychain ~/Library/Keychains/login.keychain-db` — note this may still not satisfy per-item ACL prompts).
