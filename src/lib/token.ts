import { jwtDecode } from 'jwt-decode';
import { createHash, randomUUID } from 'node:crypto';

import { API_HOST, PRODUCTION_API_HOST } from './api/constants';
import { getKeychain } from './keychain';
import UserError from './user-error';

interface Payload {
	id?: number;
	iat?: number;
	exp?: number;
}

// Config
export const SERVICE = 'vip-go-cli';
export const ENV_TOKEN_NAME = 'VIP_CLI_TOKEN';
export const TOKEN_URL = 'https://dashboard.wpvip.com/me/cli/token';

export type TokenSource = 'environment' | 'stored';
export interface ResolvedToken {
	token: Token;
	source: TokenSource;
}

export class EnvTokenError extends Error {}

type KeychainOperation = 'read' | 'save' | 'remove';

const keychainFailures: Record< KeychainOperation, string > = {
	read: 'read VIP-CLI credentials from',
	save: 'save VIP-CLI credentials to',
	remove: 'remove VIP-CLI credentials from',
};

/**
 * The OS keychain refused an operation on the stored credential. On macOS this
 * happens over SSH, where the login keychain is locked for the session and
 * cannot show an authorization prompt, and keytar rejects with a bare
 * "An unknown error occurred.".
 */
export class KeychainError extends UserError {
	constructor( operation: KeychainOperation, cause: unknown ) {
		const reason = cause instanceof Error ? cause.message : String( cause );
		const detail = /[.!?]$/.test( reason ) ? reason : `${ reason }.`;
		const remedy =
			operation === 'remove'
				? 'Run VIP-CLI from a local graphical session, or unlock the keychain.'
				: `Run VIP-CLI from a local graphical session, unlock the keychain, or set ${ ENV_TOKEN_NAME } to a Personal Access Token from ${ TOKEN_URL }.`;
		super(
			`Unable to ${ keychainFailures[ operation ] } the system keychain: ${ detail } ` +
				'If you are connected over SSH or another non-graphical session, the keychain may be locked or unable to show an authorization prompt. ' +
				remedy,
			{ cause }
		);
		this.name = 'KeychainError';
	}
}

async function withKeychainError< T >(
	operation: KeychainOperation,
	action: () => Promise< T >
): Promise< T > {
	try {
		return await action();
	} catch ( err ) {
		throw new KeychainError( operation, err );
	}
}

const environmentUUIDs = new Map< string, string >();
export default class Token {
	private readonly _raw?: string;
	private readonly _id?: number;
	private readonly iat?: Date;
	private readonly exp?: Date;

	constructor( token: string ) {
		if ( ! token ) {
			return;
		}

		token = token.trim();
		if ( ! token.length ) {
			return;
		}

		const decodedToken = jwtDecode< Payload >( token );
		this._raw = token;

		if ( decodedToken.id ) {
			this._id = decodedToken.id;
		}

		if ( decodedToken.iat ) {
			this.iat = new Date( decodedToken.iat * 1000 );
		}

		if ( decodedToken.exp ) {
			this.exp = new Date( decodedToken.exp * 1000 );
		}
	}

	public valid(): boolean {
		if ( ! this._id ) {
			return false;
		}

		if ( ! this.iat ) {
			return false;
		}

		const now = new Date();
		if ( ! this.exp ) {
			return now > this.iat;
		}

		return now > this.iat && now < this.exp;
	}

	public expired(): boolean {
		if ( ! this.exp ) {
			return false;
		}

		const now = new Date();
		return now > this.exp;
	}

	public get id(): number {
		return this._id ?? NaN;
	}

	public get raw(): string {
		return this._raw ?? '';
	}

	public static async uuid(): Promise< string > {
		const environmentToken = process.env[ ENV_TOKEN_NAME ]?.trim();
		if ( environmentToken ) {
			const fingerprint = createHash( 'sha256' ).update( environmentToken ).digest( 'hex' );
			let uuid = environmentUUIDs.get( fingerprint );
			if ( ! uuid ) {
				uuid = randomUUID();
				environmentUUIDs.set( fingerprint, uuid );
			}
			return uuid;
		}
		const service = Token.getServiceName( '-uuid' );

		const keychain = await getKeychain();
		let _uuid = await keychain.getPassword( service );
		if ( ! _uuid ) {
			_uuid = randomUUID();
			await keychain.setPassword( service, _uuid );
		}

		return _uuid;
	}

	public static async setUuid( _uuid: string ): Promise< void > {
		const service = Token.getServiceName( '-uuid' );
		const keychain = await getKeychain();
		await keychain.setPassword( service, _uuid );
	}

	public static async set( token: string ): Promise< boolean > {
		const service = Token.getServiceName();
		return withKeychainError( 'save', async () => {
			const keychain = await getKeychain();
			return keychain.setPassword( service, token );
		} );
	}

	public static isEnvironmentSet(): boolean {
		return Boolean( process.env[ ENV_TOKEN_NAME ]?.trim() );
	}

	public static async resolve(): Promise< ResolvedToken > {
		const environmentToken = process.env[ ENV_TOKEN_NAME ]?.trim();
		if ( environmentToken ) {
			let token: Token;
			try {
				token = new Token( environmentToken );
			} catch {
				throw new EnvTokenError(
					`The token in ${ ENV_TOKEN_NAME } is malformed. Replace it with a Personal Access Token from ${ TOKEN_URL }, or unset ${ ENV_TOKEN_NAME } to use stored credentials.`
				);
			}
			if ( ! token.valid() ) {
				throw new EnvTokenError(
					`The token in ${ ENV_TOKEN_NAME } is expired or invalid. Replace it with a Personal Access Token from ${ TOKEN_URL }, or unset ${ ENV_TOKEN_NAME } to use stored credentials.`
				);
			}
			return { token, source: 'environment' };
		}

		const service = Token.getServiceName();
		const raw = await withKeychainError( 'read', async () => {
			const keychain = await getKeychain();
			return keychain.getPassword( service );
		} );
		return { token: new Token( raw ?? '' ), source: 'stored' };
	}

	public static async get(): Promise< Token > {
		return ( await Token.resolve() ).token;
	}

	public static async purge(): Promise< boolean > {
		const service = Token.getServiceName();
		return withKeychainError( 'remove', async () => {
			const keychain = await getKeychain();
			return keychain.deletePassword( service );
		} );
	}

	public static getServiceName( modifier: string = '' ): string {
		let service = SERVICE;

		if ( PRODUCTION_API_HOST !== API_HOST ) {
			const sanitized = API_HOST.replace( /[^a-z0-9]/gi, '-' );

			service = `${ SERVICE }:${ sanitized }`;
		}

		return `${ service }${ modifier }`;
	}
}
