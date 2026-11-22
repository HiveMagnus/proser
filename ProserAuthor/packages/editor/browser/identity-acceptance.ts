import CanvasEditor, { ElementType, type IElement } from '@hivemagnus/canvas-word-engine';
import { EDITOR_CLIPBOARD } from '@hivemagnus/canvas-word-engine/testing';

function ids(elements: IElement[]): string[] {
  return elements.flatMap((element) => [
    ...(element.id ? [element.id] : []),
    ...(element.valueList ? ids(element.valueList) : []),
    ...(element.trList?.flatMap((row) => [
      ...(row.id ? [row.id] : []),
      ...row.tdList.flatMap((cell) => [...(cell.id ? [cell.id] : []), ...ids(cell.value)]),
    ]) ?? []),
  ]);
}

/** Public serialization/clipboard APIs in Chromium with native clipboard permission. */
export async function identityAcceptance() {
  const host = document.createElement('div');
  document.body.append(host);
  const options = { header: { disabled: true }, footer: { disabled: true } };
  let editor = new CanvasEditor(
    host,
    {
      main: [
        { value: 'Before' },
        {
          type: ElementType.TABLE,
          id: 'identity-table',
          value: '',
          colgroup: [{ width: 150 }, { width: 150 }],
          trList: [
            {
              id: 'identity-row',
              height: 40,
              tdList: [
                { id: 'identity-cell', colspan: 1, rowspan: 1, value: [{ value: 'Cell 😀 é' }] },
                { id: 'identity-neighbor', colspan: 1, rowspan: 1, value: [{ value: 'Neighbor' }] },
              ],
            },
          ],
        },
        { value: '\nAfter' },
      ],
    },
    options,
  );
  const check = (value: boolean, message: string) => {
    if (!value) throw new Error(message);
  };
  const saved = () => editor.command.getValue({ extraPickAttrs: ['id'] });
  const tables = () => saved().data.main.filter((element) => element.type === ElementType.TABLE);
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  try {
    const initial = saved();
    check(ids(initial.data.main).includes('identity-cell'), 'Explicit identity retention failed');
    check(
      ids(editor.command.getValue().data.main).length === 0,
      'Default serialization retained IDs',
    );
    const worker = await editor.command.getValueAsync({ extraPickAttrs: ['id'] });
    check(
      same(
        [worker.data.header, worker.data.main, worker.data.footer],
        [initial.data.header, initial.data.main, initial.data.footer],
      ),
      'Worker serialization differs from explicit synchronous serialization',
    );
    check(
      ids((await editor.command.getValueAsync()).data.main).length === 0,
      'Default worker serialization retained IDs',
    );

    editor.command.executeSelectAll();
    await editor.command.executeCopy();
    const clipboard = JSON.parse(localStorage.getItem(EDITOR_CLIPBOARD)!);
    check(ids(clipboard.elementList).length === 0, 'Internal clipboard retained IDs');
    check(
      (await navigator.clipboard.readText()) === clipboard.text,
      'Native clipboard was not written',
    );
    for (const count of [2, 3]) {
      const last = editor.command.getRuntimeElementList().length - 1;
      editor.command.executeSetRange(last, last);
      editor.command.executeFocus({ range: editor.command.getRange() });
      editor.command.executePaste();
      const deadline = Date.now() + 5000;
      while (tables().length !== count && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      check(tables().length === count, 'Native paste did not insert a separate table');
    }
    const pasted = saved();
    const allIds = ids(pasted.data.main);
    check(new Set(allIds).size === allIds.length, 'Repeated paste duplicated an identity');
    check(
      same(
        tables()[0],
        initial.data.main.find((element) => element.type === ElementType.TABLE),
      ),
      'Repeated paste changed the original table',
    );

    editor.command.executeUndo();
    check(tables().length === 2, 'Undo did not remove the second paste');
    editor.command.executeRedo();
    check(same(saved().data, pasted.data), 'Redo changed pasted identities or content');
    const range = editor.command.getKeywordRangeList('Cell 😀 é')[1]!;
    check(Boolean(range), 'Pasted cell search target missing');
    editor.command.executeSetPositionContext(range);
    editor.command.executeSetRange(range.startIndex, range.endIndex);
    editor.command.executeInsertElementList([{ value: 'Edited pasted cell' }]);
    check(
      same(
        tables()[0],
        initial.data.main.find((element) => element.type === ElementType.TABLE),
      ),
      'Editing pasted cell changed original table',
    );
    check(
      tables()[1]!
        .trList![0]!.tdList[0]!.value.map((element) => element.value)
        .join('')
        .includes('Edited pasted cell'),
      'Pasted cell edit missed its target',
    );
    const edited = saved();
    editor.destroy();
    host.innerHTML = '';
    editor = new CanvasEditor(host, edited.data, options);
    check(same(saved().data, edited.data), 'Recreation changed saved identities or content');
    return {
      uniqueIds: allIds.length,
      tableCount: 3,
      nativeClipboard: true,
      workerSerialization: true,
      undoRedo: true,
      independentCellEdit: true,
      recreation: true,
    };
  } finally {
    editor.destroy();
    host.remove();
    localStorage.removeItem(EDITOR_CLIPBOARD);
  }
}
