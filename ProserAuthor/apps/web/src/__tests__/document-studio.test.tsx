import { documentCapabilitiesFixture } from './document-capabilities-fixture';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentStudio } from '@/components/editor/document-studio';
import * as api from '@/lib/document-api';
import {
  documentFromText,
  type BookLayoutSnapshot,
  type StructureSnapshot,
  type DocumentManifestResponse,
} from '@hivemagnus/proser-contracts';
const layout: BookLayoutSnapshot = {
  schemaVersion: 1,
  book: documentFromText('', () => crypto.randomUUID()).layout,
  chapters: {},
  frontMatter: [],
  backMatter: [],
  styles: { text: {}, paragraph: {} },
};
const route = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => route,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'author-one' } } }),
}));
vi.mock('@/lib/document-api', () => ({
  getDocumentManifest: vi.fn(),
  getDocumentScope: vi.fn(),
  getDocumentCapabilities: vi.fn(),
}));
vi.mock('@/components/editor/document-layout-settings', () => ({
  DocumentLayoutSettings: ({
    onDirtyChange,
    onCommitted,
    disabled,
  }: {
    onDirtyChange: (dirty: boolean) => void;
    onCommitted: () => void;
    disabled?: boolean;
  }) => (
    <div>
      <button disabled={disabled} onClick={() => onDirtyChange(true)}>
        Unacknowledged layout edit
      </button>
      <button onClick={() => onDirtyChange(false)}>Acknowledge layout save</button>
      <button onClick={onCommitted}>Refresh acknowledged layout</button>
    </div>
  ),
}));
vi.mock('@/components/editor/document-passage-workspace', () => ({
  DocumentPassageWorkspace: ({
    sceneId,
    onDirtyChange,
  }: {
    sceneId: string;
    onDirtyChange: (dirty: boolean) => void;
  }) => (
    <div data-testid="owned-editor">
      Scene {sceneId}
      <button onClick={() => onDirtyChange(true)}>Unacknowledged edit</button>
      <button onClick={() => onDirtyChange(false)}>Acknowledge save</button>
    </div>
  ),
}));
vi.mock('@/components/editor/document-passage-window-workspace', () => ({
  DocumentPassageWindowWorkspace: ({
    references,
    onDirtyChange,
  }: {
    references: Array<{ sceneId: number }>;
    onDirtyChange: (dirty: boolean) => void;
  }) => (
    <div data-testid="editing-window">
      {references.map((reference) => (
        <span key={reference.sceneId} data-testid="window-scene">
          {reference.sceneId}
        </span>
      ))}
      <button onClick={() => onDirtyChange(true)}>Unacknowledged window edit</button>
      <button onClick={() => onDirtyChange(false)}>Acknowledge window save</button>
    </div>
  ),
}));
const structure: StructureSnapshot = {
  schemaVersion: 1,
  book: {
    title: 'Owned structured novel',
    summary: null,
    genre: null,
    targetAudience: null,
    draftStatus: 'draft',
    tagline: null,
    storyOutline: null,
    storyArchetypeKey: null,
    selectedImageId: 0,
  },
  acts: [
    {
      id: 10,
      actNumber: 1,
      title: 'Act I',
      summary: null,
      selectedImageId: 0,
      deletedAt: null,
      createdAt: null,
    },
  ],
  chapters: [
    {
      id: 20,
      actId: 10,
      chapterNumber: 1,
      title: 'Chapter One',
      summary: null,
      selectedImageId: 0,
      deletedAt: null,
      createdAt: null,
    },
  ],
  scenes: [30, 31].map((id, index) => ({
    id,
    chapterId: 20,
    sceneNumber: index + 1,
    summary: null,
    outline: null,
    beatsMeta: null,
    beatsMetaIsSqlNull: true,
    selectedImageId: 0,
    deletedAt: null,
    createdAt: null,
  })),
};
const manifest: DocumentManifestResponse = {
  schemaVersion: 1,
  revisionId: 'head',
  contentHash: 'manifest-hash',
  scenes: [31, 30].map((sceneId) => ({
    sceneId,
    chapterId: 20,
    sceneNumber: sceneId === 30 ? 1 : 2,
    revisionId: `body-${sceneId}`,
    contentHash: `hash-${sceneId}`,
    wordCount: 10,
  })),
  scopes: {
    structure: { revisionId: 'structure', contentHash: 'structure-hash' },
    canon: { revisionId: 'canon', contentHash: 'canon-hash' },
    layout: { revisionId: 'layout', contentHash: 'layout-hash' },
  },
  totals: { projection: 'final', wordCount: 20, sceneCount: 2 },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.getDocumentCapabilities).mockResolvedValue(documentCapabilitiesFixture());
  vi.mocked(api.getDocumentManifest).mockResolvedValue(structuredClone(manifest));
  vi.mocked(api.getDocumentScope)
    .mockResolvedValueOnce({
      revisionId: 'structure',
      contentHash: 'structure-hash',
      bookRevisionId: 'head',
      content: structuredClone(structure),
    })
    .mockResolvedValue({
      revisionId: 'layout',
      contentHash: 'layout-hash',
      bookRevisionId: 'head',
      content: layout,
    });
});
describe('structured studio navigation', () => {
  it('uses canonical structure order and waits for acknowledgement before changing scenes', async () => {
    const user = userEvent.setup();
    render(<DocumentStudio bookId="1" route="/manuscript" />);
    expect(await screen.findByTestId('owned-editor')).toHaveTextContent('Scene 30');
    await user.click(screen.getByRole('button', { name: 'Unacknowledged edit' }));
    await user.click(screen.getByRole('button', { name: 'Next scene' }));
    expect(route.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open selected scene after saving' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Acknowledge save' }));
    await user.click(screen.getByRole('button', { name: 'Open selected scene after saving' }));
    expect(route.replace).toHaveBeenCalledWith('/manuscript?bookId=1&sceneId=31');
  });
  it('keeps owned scene and story UI mounted while self-acknowledged metadata refresh is pending or fails', async () => {
    const user = userEvent.setup();
    render(<DocumentStudio bookId="1" route="/manuscript" />);
    const editor = await screen.findByTestId('owned-editor');
    await user.click(screen.getByRole('button', { name: 'Page setup' }));
    const story = screen.getByRole('button', { name: 'Refresh acknowledged layout' });
    let reject!: (error: Error) => void;
    vi.mocked(api.getDocumentManifest).mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    await user.click(story);
    expect(editor.isConnected).toBe(true);
    expect(story.isConnected).toBe(true);
    reject(new Error('Refresh interrupted'));
    await screen.findByText('Refresh interrupted');
    expect(screen.getByTestId('owned-editor')).toBe(editor);
    expect(screen.getByRole('button', { name: 'Refresh acknowledged layout' })).toBe(story);
  });
  it('protects layout drafts and disables layout commits while body work is unacknowledged', async () => {
    const user = userEvent.setup();
    render(<DocumentStudio bookId="1" route="/manuscript" />);
    await screen.findByTestId('owned-editor');
    await user.click(screen.getByRole('button', { name: 'Page setup' }));
    await user.click(screen.getByRole('button', { name: 'Unacknowledged edit' }));
    expect(screen.getByRole('button', { name: 'Unacknowledged layout edit' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Acknowledge save' }));
    await user.click(screen.getByRole('button', { name: 'Unacknowledged layout edit' }));
    await user.click(screen.getByRole('button', { name: 'Next scene' }));
    expect(route.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Page setup' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Acknowledge layout save' }));
    await user.click(screen.getByRole('button', { name: 'Open selected scene after saving' }));
    expect(route.replace).toHaveBeenCalledWith('/manuscript?bookId=1&sceneId=31');
  });
  it('reports an unavailable requested identity without selecting another scene implicitly', async () => {
    const user = userEvent.setup();
    render(<DocumentStudio bookId="1" sceneId="999" route="/manuscript" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('requested scene is unavailable');
    expect(screen.queryByTestId('owned-editor')).not.toBeInTheDocument();
    expect(route.replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Open first saved scene' }));
    expect(route.replace).toHaveBeenCalledWith('/manuscript?bookId=1&sceneId=30');
  });
  it('refuses a scope from a different revision before mounting an editor', async () => {
    vi.mocked(api.getDocumentScope).mockReset().mockResolvedValueOnce({
      revisionId: 'structure',
      contentHash: 'structure-hash',
      bookRevisionId: 'newer-head',
      content: structure,
    });
    render(<DocumentStudio bookId="1" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('book changed'));
    expect(screen.queryByTestId('owned-editor')).not.toBeInTheDocument();
  });
  it('mounts a contiguous three-scene whole-book window and fences window switching while dirty', async () => {
    const user = userEvent.setup();
    const six = structuredClone(structure);
    six.scenes = [30, 31, 32, 33, 34, 35].map((id, index) => ({
      ...six.scenes[0]!,
      id,
      sceneNumber: index + 1,
    }));
    const sixManifest = {
      ...manifest,
      scenes: six.scenes.map((scene) => ({
        ...manifest.scenes[0]!,
        sceneId: scene.id,
        sceneNumber: scene.sceneNumber,
      })),
    };
    vi.mocked(api.getDocumentManifest).mockResolvedValue(sixManifest);
    vi.mocked(api.getDocumentScope)
      .mockReset()
      .mockResolvedValueOnce({
        revisionId: 'structure',
        contentHash: 'structure-hash',
        bookRevisionId: 'head',
        content: six,
      })
      .mockResolvedValue({
        revisionId: 'layout',
        contentHash: 'layout-hash',
        bookRevisionId: 'head',
        content: layout,
      });
    const { rerender } = render(<DocumentStudio bookId="1" route="/manuscript" />);
    await screen.findByTestId('owned-editor');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Manuscript editing scope' }),
      'book',
    );
    expect(screen.getAllByTestId('window-scene').map((scene) => scene.textContent)).toEqual([
      '30',
      '31',
      '32',
    ]);
    expect(route.replace).toHaveBeenLastCalledWith('/manuscript?bookId=1&sceneId=30&scope=book');
    route.replace.mockClear();
    await user.click(screen.getByRole('button', { name: 'Unacknowledged window edit' }));
    await user.click(screen.getByRole('button', { name: 'Next editing window' }));
    expect(route.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Manuscript editing scope' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Acknowledge window save' }));
    await user.click(screen.getByRole('button', { name: 'Open selected scene after saving' }));
    expect(route.replace).toHaveBeenCalledWith('/manuscript?bookId=1&sceneId=33&scope=book');
    rerender(<DocumentStudio bookId="1" sceneId="33" route="/manuscript" />);
    expect(screen.getAllByTestId('window-scene').map((scene) => scene.textContent)).toEqual([
      '33',
      '34',
      '35',
    ]);
  });
});

function chapterNavigationFixture() {
  const snapshot = structuredClone(structure);
  snapshot.acts.push({ ...snapshot.acts[0]!, id: 11, actNumber: 2 });
  snapshot.chapters = [
    { ...snapshot.chapters[0]!, id: 22, actId: 11, chapterNumber: 1, title: 'Later act chapter' },
    { ...snapshot.chapters[0]!, id: 21, chapterNumber: 2, title: 'Empty chapter' },
    snapshot.chapters[0]!,
    {
      ...snapshot.chapters[0]!,
      id: 23,
      chapterNumber: 3,
      title: 'Deleted chapter',
      deletedAt: '2026-10-08T00:00:00Z',
    },
  ];
  snapshot.scenes = [30, 31, 32, 33, 34, 40].map((id, index) => ({
    ...structure.scenes[0]!,
    id,
    chapterId: id === 40 ? 22 : 20,
    sceneNumber: id === 40 ? 1 : index + 1,
  }));
  vi.mocked(api.getDocumentManifest).mockResolvedValue({
    ...manifest,
    scenes: snapshot.scenes.map((scene) => ({
      ...manifest.scenes[0]!,
      sceneId: scene.id,
      chapterId: scene.chapterId,
      sceneNumber: scene.sceneNumber,
    })),
  });
  vi.mocked(api.getDocumentScope)
    .mockReset()
    .mockImplementation(async (_book, scope) =>
      scope === 'structure'
        ? {
            revisionId: 'structure',
            contentHash: 'structure-hash',
            bookRevisionId: 'head',
            content: snapshot,
          }
        : {
            revisionId: 'layout',
            contentHash: 'layout-hash',
            bookRevisionId: 'head',
            content: layout,
          },
    );
}

describe('chapter scope navigation', () => {
  it('switches the picker and arrows to ordered stable chapter identities, including empty chapters', async () => {
    chapterNavigationFixture();
    const user = userEvent.setup();
    const targetChanged = vi.fn();
    const view = render(
      <DocumentStudio bookId="1" sceneId="31" route="/manuscript" onTargetChange={targetChanged} />,
    );
    await screen.findByTestId('owned-editor');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Manuscript editing scope' }),
      'chapter',
    );
    const picker = screen.getByRole('combobox', { name: 'Navigate to chapter' });
    expect(
      [...picker.querySelectorAll('option')].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ['20', 'Chapter One'],
      ['21', 'Empty chapter · No scenes'],
      ['22', 'Later act chapter'],
    ]);
    expect(picker).toHaveValue('20');
    expect(screen.queryByRole('combobox', { name: 'Navigate to scene' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous chapter' })).toBeDisabled();
    expect(screen.getAllByTestId('window-scene').map((node) => node.textContent)).toEqual([
      '30',
      '31',
      '32',
    ]);
    expect(route.replace).toHaveBeenLastCalledWith(
      '/manuscript?bookId=1&scope=chapter&chapterId=20&sceneId=31',
    );
    await user.click(screen.getByRole('button', { name: 'Next chapter' }));
    expect(route.replace).toHaveBeenLastCalledWith(
      '/manuscript?bookId=1&scope=chapter&chapterId=21',
    );
    view.rerender(
      <DocumentStudio
        bookId="1"
        chapterId="21"
        route="/manuscript"
        onTargetChange={targetChanged}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Navigate to chapter' })).toHaveValue('21');
    expect(screen.getByRole('status')).toHaveTextContent('This chapter has no saved scenes');
    expect(targetChanged).toHaveBeenLastCalledWith({
      bookId: '1',
      sceneId: null,
      title: 'Owned structured novel',
    });
    expect(screen.queryByTestId('editing-window')).not.toBeInTheDocument();
    expect(screen.queryByTestId('owned-editor')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next chapter' }));
    expect(route.replace).toHaveBeenLastCalledWith(
      '/manuscript?bookId=1&scope=chapter&chapterId=22&sceneId=40',
    );
    view.rerender(<DocumentStudio bookId="1" chapterId="22" sceneId="40" route="/manuscript" />);
    expect(screen.getAllByTestId('window-scene').map((node) => node.textContent)).toEqual(['40']);
    expect(screen.getByRole('button', { name: 'Next chapter' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous chapter' }));
    expect(route.replace).toHaveBeenLastCalledWith(
      '/manuscript?bookId=1&scope=chapter&chapterId=21',
    );
  });
  it('retains the exact dirty window until acknowledgement before navigating to a chapter', async () => {
    chapterNavigationFixture();
    const user = userEvent.setup();
    render(<DocumentStudio bookId="1" chapterId="20" sceneId="33" route="/m/studio" />);
    await screen.findByTestId('editing-window');
    expect(screen.getAllByTestId('window-scene').map((node) => node.textContent)).toEqual([
      '33',
      '34',
    ]);
    await user.click(screen.getByRole('button', { name: 'Unacknowledged window edit' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Navigate to chapter' }), '22');
    expect(route.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Navigate to chapter' })).toHaveValue('20');
    expect(
      screen.getByRole('button', { name: 'Open selected chapter after saving' }),
    ).toBeDisabled();
    expect(screen.getAllByTestId('window-scene').map((node) => node.textContent)).toEqual([
      '33',
      '34',
    ]);
    await user.click(screen.getByRole('button', { name: 'Acknowledge window save' }));
    await user.click(screen.getByRole('button', { name: 'Open selected chapter after saving' }));
    expect(route.replace).toHaveBeenCalledExactlyOnceWith(
      '/m/studio?bookId=1&scope=chapter&chapterId=22&sceneId=40',
    );
  });
  it('restores chapter routes, rejects unrelated scene targets, and never silently substitutes an unknown chapter', async () => {
    chapterNavigationFixture();
    const user = userEvent.setup();
    const view = render(
      <DocumentStudio bookId="1" chapterId="22" sceneId="31" route="/manuscript" />,
    );
    await screen.findByTestId('editing-window');
    expect(screen.getAllByTestId('window-scene').map((node) => node.textContent)).toEqual(['40']);
    expect(route.replace).not.toHaveBeenCalled();
    view.rerender(<DocumentStudio bookId="1" chapterId="999" sceneId="31" route="/manuscript" />);
    expect(screen.getByRole('alert')).toHaveTextContent('requested chapter is unavailable');
    expect(screen.queryByTestId('editing-window')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open first saved chapter' }));
    expect(route.replace).toHaveBeenLastCalledWith(
      '/manuscript?bookId=1&scope=chapter&chapterId=20&sceneId=30',
    );
  });
  it('restores whole-book focus from a validated scope and returns to a scene without retaining chapter context', async () => {
    chapterNavigationFixture();
    const user = userEvent.setup();
    const view = render(
      <DocumentStudio
        bookId="1"
        requestedEditingScope="book"
        chapterId="22"
        sceneId="40"
        route="/manuscript"
      />,
    );
    await screen.findByTestId('editing-window');
    expect(screen.getByRole('combobox', { name: 'Manuscript editing scope' })).toHaveValue('book');
    expect(screen.getByRole('combobox', { name: 'Navigate to scene' })).toHaveValue('40');
    expect(screen.getAllByTestId('window-scene').map((node) => node.textContent)).toEqual([
      '33',
      '34',
      '40',
    ]);
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Manuscript editing scope' }),
      'scene',
    );
    expect(route.replace).toHaveBeenLastCalledWith('/manuscript?bookId=1&sceneId=40');
    expect(screen.getByTestId('owned-editor')).toHaveTextContent('Scene 40');
    view.rerender(
      <DocumentStudio
        bookId="1"
        chapterId="20"
        sceneId="31"
        requestedEditingScope="chapter"
        route="/manuscript"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Navigate to chapter' })).toHaveValue('20');
    view.rerender(
      <DocumentStudio
        bookId="1"
        requestedEditingScope="book"
        chapterId="22"
        sceneId="40"
        route="/manuscript"
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Manuscript editing scope' })).toHaveValue('book');
    expect(screen.getByRole('combobox', { name: 'Navigate to scene' })).toHaveValue('40');
  });
});
