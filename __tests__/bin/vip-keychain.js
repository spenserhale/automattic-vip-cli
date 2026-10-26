import command from '../../src/lib/cli/command';
import * as exit from '../../src/lib/cli/exit';

// Over SSH on macOS the login keychain is locked for the session, and keytar
// rejects every access to the stored credential with a bare native error.
const mockKeychain = {
	getPassword: jest.fn(),
	setPassword: jest.fn(),
	deletePassword: jest.fn(),
};

jest.mock( '../../src/lib/keychain', () => ( { getKeychain: async () => mockKeychain } ) );
jest.mock( '../../src/lib/tracker', () => ( { trackEvent: async () => [] } ) );
jest.mock( '../../src/lib/cli/exit', () => ( { withError: jest.fn() } ) );
jest.mock( '../../src/lib/cli/command', () => {
	const runner = { command: () => runner, argv: jest.fn( async () => {} ) };
	return {
		__esModule: true,
		default: jest.fn( () => runner ),
		containsAppEnvArgument: () => false,
	};
} );

describe( 'root command when the keychain is unavailable', () => {
	const originalArgv = process.argv;
	const originalToken = process.env.VIP_CLI_TOKEN;

	beforeEach( () => {
		delete process.env.VIP_CLI_TOKEN;
		jest.clearAllMocks();
		mockKeychain.getPassword.mockRejectedValue( new Error( 'An unknown error occurred.' ) );
	} );

	afterEach( () => {
		process.argv = originalArgv;
		if ( originalToken === undefined ) {
			delete process.env.VIP_CLI_TOKEN;
		} else {
			process.env.VIP_CLI_TOKEN = originalToken;
		}
	} );

	it.each( [ [ '-v' ], [ '--version' ], [ '-h' ], [ 'help' ], [ 'logout' ] ] )(
		'runs vip %s without reading the keychain',
		async arg => {
			process.argv = [ process.execPath, 'vip', arg ];
			jest.isolateModules( () => require( '../../src/bin/vip' ) );
			await new Promise( resolve => setImmediate( resolve ) );

			expect( mockKeychain.getPassword ).not.toHaveBeenCalled();
			expect( exit.withError ).not.toHaveBeenCalled();
			expect( command ).toHaveBeenCalled();
		}
	);
} );
