import { describe, it, expect, vi } from 'vitest';
import {
  API_KEY_SECRET,
  SIGNING_KEY_SECRET,
  WhetstoneSecrets,
  type SecretStore,
} from '../../src/shared/secrets';
import { sign, verify } from '../../src/shared/crypto';

/** In-memory stand-in for `vscode.SecretStorage`. */
class FakeSecretStore implements SecretStore {
  private readonly map = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

describe('WhetstoneSecrets — provider API key', () => {
  it('round-trips a set key through SecretStorage', async () => {
    const store = new FakeSecretStore();
    const secrets = new WhetstoneSecrets(store);

    await secrets.setApiKey('sk-ant-test-key');
    expect(await secrets.getApiKey()).toBe('sk-ant-test-key');
  });

  it('stores the key under the documented SecretStorage key only', async () => {
    const store = new FakeSecretStore();
    const setSpy = vi.spyOn(store, 'store');
    await new WhetstoneSecrets(store).setApiKey('sk-ant-test-key');
    expect(setSpy).toHaveBeenCalledWith(API_KEY_SECRET, 'sk-ant-test-key');
  });

  it('returns undefined when no key has been set', async () => {
    expect(await new WhetstoneSecrets(new FakeSecretStore()).getApiKey()).toBeUndefined();
  });

  it('clears a previously set key', async () => {
    const secrets = new WhetstoneSecrets(new FakeSecretStore());
    await secrets.setApiKey('sk-ant-test-key');
    await secrets.clearApiKey();
    expect(await secrets.getApiKey()).toBeUndefined();
  });
});

describe('WhetstoneSecrets — "no key set" detection (consent gate)', () => {
  it('reports false before a key is set and true afterward', async () => {
    const secrets = new WhetstoneSecrets(new FakeSecretStore());
    expect(await secrets.hasApiKey()).toBe(false);

    await secrets.setApiKey('sk-ant-test-key');
    expect(await secrets.hasApiKey()).toBe(true);
  });

  it('treats an empty stored key as "no key set"', async () => {
    const secrets = new WhetstoneSecrets(new FakeSecretStore());
    await secrets.setApiKey('');
    expect(await secrets.hasApiKey()).toBe(false);
  });
});

describe('WhetstoneSecrets — per-device signing key', () => {
  it('generates a usable Ed25519 keypair on first read', async () => {
    const keyPair = await new WhetstoneSecrets(new FakeSecretStore()).getOrCreateSigningKey();
    expect(keyPair.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(keyPair.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('generates the key once and reuses it on later reads', async () => {
    const store = new FakeSecretStore();
    const storeSpy = vi.spyOn(store, 'store');

    const first = await new WhetstoneSecrets(store).getOrCreateSigningKey();
    // A fresh wrapper over the same store simulates a later session.
    const second = await new WhetstoneSecrets(store).getOrCreateSigningKey();

    expect(second).toEqual(first);
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy).toHaveBeenCalledWith(SIGNING_KEY_SECRET, expect.any(String));
  });

  it('regenerates when the stored keypair is corrupt or incomplete', async () => {
    const corruptStore = new FakeSecretStore();
    await corruptStore.store(SIGNING_KEY_SECRET, 'not-json{');
    const fromCorrupt = await new WhetstoneSecrets(corruptStore).getOrCreateSigningKey();
    expect(fromCorrupt.privateKey).toContain('BEGIN PRIVATE KEY');

    const partialStore = new FakeSecretStore();
    await partialStore.store(SIGNING_KEY_SECRET, JSON.stringify({ publicKey: 'only-public' }));
    const fromPartial = await new WhetstoneSecrets(partialStore).getOrCreateSigningKey();
    expect(fromPartial.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('persists a keypair that signs and verifies (a real keygen, not a stub)', async () => {
    const keyPair = await new WhetstoneSecrets(new FakeSecretStore()).getOrCreateSigningKey();
    const signature = sign('latest-hash', keyPair.privateKey);
    expect(verify('latest-hash', signature, keyPair.publicKey)).toBe(true);
  });
});

describe('WhetstoneSecrets — secrets are never logged', () => {
  it('no accessor writes a secret value to the console or stdio', async () => {
    const store = new FakeSecretStore();
    const secrets = new WhetstoneSecrets(store);

    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const apiKey = 'sk-ant-super-secret-key';
    try {
      await secrets.setApiKey(apiKey);
      await secrets.getApiKey();
      await secrets.hasApiKey();
      const keyPair = await secrets.getOrCreateSigningKey();
      await secrets.clearApiKey();

      const everythingLogged = [...consoleSpies, stdoutSpy, stderrSpy]
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map((arg) => String(arg))
        .join('\n');

      expect(everythingLogged).not.toContain(apiKey);
      expect(everythingLogged).not.toContain(keyPair.privateKey);
    } finally {
      [...consoleSpies, stdoutSpy, stderrSpy].forEach((spy) => spy.mockRestore());
    }
  });
});
