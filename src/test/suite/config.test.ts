import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  DEFAULT_SETTINGS,
  GRAMMAR_SEVERITIES,
  PROVIDER_IDS,
  getSettings,
} from '../../shared/config';

describe('Whetstone configuration (live VS Code config)', () => {
  it('resolves the contributed settings to their typed defaults', () => {
    const settings = getSettings();

    assert.ok(
      PROVIDER_IDS.includes(settings.activeProvider),
      'activeProvider should resolve to a known provider id',
    );
    assert.strictEqual(settings.activeProvider, DEFAULT_SETTINGS.activeProvider);
    assert.strictEqual(settings.ledgerInWorkspace, DEFAULT_SETTINGS.ledgerInWorkspace);
    assert.ok(
      GRAMMAR_SEVERITIES.includes(settings.grammarSeverity),
      'grammarSeverity should resolve to a known severity',
    );
    assert.strictEqual(settings.grammarSeverity, DEFAULT_SETTINGS.grammarSeverity);
    assert.strictEqual(settings.telemetryEnabled, DEFAULT_SETTINGS.telemetryEnabled);
    assert.strictEqual(settings.models.coaching, undefined);
    assert.strictEqual(settings.models.judge, undefined);
  });

  it('reads the registered configuration values with their package.json defaults', () => {
    const config = vscode.workspace.getConfiguration('whetstone');

    assert.strictEqual(config.get('activeProvider'), 'anthropic');
    assert.strictEqual(config.get('grammar.severity'), 'info');
    assert.strictEqual(config.get('telemetry.enabled'), true);
    assert.strictEqual(config.get('ledger.storeInWorkspace'), false);
    assert.strictEqual(config.get('models.coaching'), '');
    assert.strictEqual(config.get('models.judge'), '');
  });
});
