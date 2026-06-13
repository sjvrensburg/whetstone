import * as assert from 'assert';
import * as vscode from 'vscode';
import { COMMAND_IDS } from '../../commands';
import { VIEW_IDS } from '../../ui';

const EXTENSION_ID = 'whetstone.whetstone';

function getExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} should be present in the test host`);
  return ext;
}

describe('Whetstone activation', () => {
  it('activates when a Markdown file is opened (no thrown error)', async () => {
    const ext = getExtension();
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: '# Hello\n\nA paragraph to coach.',
    });
    await vscode.window.showTextDocument(doc);
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'extension should be active after opening Markdown');
  });

  it('contributes the sidebar view container and its views', () => {
    const ext = getExtension();
    const contributes = (ext.packageJSON as Record<string, unknown>).contributes as {
      viewsContainers?: { activitybar?: Array<{ id: string }> };
      views?: Record<string, Array<{ id: string }>>;
    };

    const containers = contributes.viewsContainers?.activitybar ?? [];
    assert.ok(
      containers.some((c) => c.id === 'whetstone'),
      'the whetstone activity-bar view container should be contributed',
    );

    const views = contributes.views?.whetstone ?? [];
    const contributedViewIds = views.map((v) => v.id);
    for (const viewId of VIEW_IDS) {
      assert.ok(
        contributedViewIds.includes(viewId),
        `view ${viewId} should be contributed under the whetstone container`,
      );
    }
  });

  it('reveals the sidebar view container in the test host', async () => {
    // Auto-generated focus command for the container; resolving without throwing
    // confirms the container is registered and focusable (i.e. visible).
    await vscode.commands.executeCommand('workbench.view.extension.whetstone');
  });

  it('registers each no-op command so it resolves without throwing', async () => {
    getExtension();
    const registered = await vscode.commands.getCommands(true);
    for (const id of COMMAND_IDS) {
      assert.ok(registered.includes(id), `command ${id} should be registered`);
      // No-op handlers resolve to undefined; the assertion is that nothing throws.
      await vscode.commands.executeCommand(id);
    }
  });
});
