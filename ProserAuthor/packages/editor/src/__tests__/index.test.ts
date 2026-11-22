import { describe, it, expect } from 'vitest';
describe('@cheftaco/proser-editor', () => {
  it('exports the owned Canvas and semantic surfaces without the retired Tiptap contract', async () => {
    const module = await import('../index.js');
    expect(module.CanvasDocumentEditor).toBeDefined();
    expect(module.SemanticDocument).toBeDefined();
    expect(module.documentToCanvas).toBeDefined();
    expect(module.paragraphSelection).toBeDefined();
    expect(module).not.toHaveProperty('ProseEditor');
    expect(module).not.toHaveProperty('useProseEditor');
  });
});
