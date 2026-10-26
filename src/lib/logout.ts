import debugLib from 'debug';

import http from '../lib/api/http';
import tokenCache from '../lib/rechallenge/token-cache';
import Token, { ENV_TOKEN_NAME } from '../lib/token';
import { trackEvent } from '../lib/tracker';

const debug = debugLib( '@automattic/vip:logout' );

export default async (): Promise< void > => {
	if ( Token.isEnvironmentSet() ) {
		console.log(
			`The ${ ENV_TOKEN_NAME } environment variable is still active. Unset it to stop authenticating with that token; stored credentials were left untouched.`
		);
		return;
	}

	// Without a readable stored token there is nothing to revoke server-side.
	// Removing it below still runs, and reports the keychain failure if the
	// keychain refuses that too, instead of claiming the logout succeeded.
	let storedToken: Token | undefined;
	try {
		storedToken = await Token.get();
	} catch ( err ) {
		debug( 'Skipping server-side logout; could not read the stored token:', err );
	}

	try {
		if ( storedToken?.raw ) {
			await http( '/logout', { method: 'post' } );
		}
	} finally {
		await Token.purge();

		try {
			await tokenCache.clearAll();
		} catch ( err ) {
			debug( 'Could not clear cached elevated tokens:', err );
		}
	}

	await trackEvent( 'logout_command_execute' );
};
