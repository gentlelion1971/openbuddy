// Minimal fake of the Electron main-process API surface the app uses in
// plain-node unit tests. safeStorage "encryption" is a reversible marker
// encoding — good enough to test the store/retrieve round-trip, never used
// for real secrets.
// All code, comments, log messages and docs in this project are English only.

const PREFIX = 'stub-enc-v1:';

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(PREFIX + plain, 'utf8'),
  decryptString: (buf) => {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (!text.startsWith(PREFIX)) throw new Error('decrypt failed');
    return text.slice(PREFIX.length);
  },
};

export const app = {
  getPath: (name) => (name === 'userData' ? '/tmp/openbuddy-test-user-data' : '/tmp/openbuddy-test'),
  getAppPath: () => '/tmp/openbuddy-test-app',
  getVersion: () => '0.2.0',
};
