import chalk from 'chalk';
import debugLib from 'debug';

import http from '../lib/api/http';
import tokenCache from '../lib/rechallenge/token-cache';
import Token, { ENV_TOKEN_NAME } from '../lib/token';
import { trackEvent } from '../lib/tracker';

const debug = debugLib( '@automattic/vip:logout' );

export default async (): Promise< void > => {
	try {
		// VIP_CLI_TOKEN is user-managed: logout must not invalidate it server-side.
		// Server-side logout is also skipped when the stored token cannot be read
		// (e.g. a locked OS keychain over SSH) — there is nothing usable to send.
		if ( ! Token.isEnvTokenSet() ) {
			let storedToken;
			try {
				storedToken = await Token.get();
			} catch ( err ) {
				debug( 'Skipping server-side logout; could not read the stored token:', err );
			}

			if ( storedToken?.valid() ) {
				await http( '/logout', { method: 'post' } );
			}
		}
	} finally {
		try {
			await Token.purge();
		} catch ( err ) {
			debug( 'Could not purge the stored token from the keychain:', err );
		}

		await tokenCache.clearAll();
	}

	// Purging the keychain does not clear the env var, so the CLI would remain
	// authenticated via VIP_CLI_TOKEN. Tell the user how to fully log out.
	if ( Token.isEnvTokenSet() ) {
		console.log(
			chalk.yellow(
				`Note: ${ ENV_TOKEN_NAME } is still set in your environment and continues to authenticate ` +
					`VIP-CLI. Unset ${ ENV_TOKEN_NAME } to fully log out.`
			)
		);
	}

	await trackEvent( 'logout_command_execute' );
};
