import Editor, { ElementType, type IElement } from '@hivemagnus/canvas-word-engine';
import { Draw } from '@hivemagnus/canvas-word-engine/testing';
import type { IRow } from '@hivemagnus/canvas-word-engine/testing';
const host = document.getElementById('upstream-core')!;
let editor: Editor;
const draws = new WeakMap<Editor, Draw>();
const captures: Draw[] = [];
const compute = Draw.prototype.computeRowList;
Draw.prototype.computeRowList = function (...args) {
  if (!captures.includes(this)) captures.push(this);
  return compute.apply(this, args);
};
const draw = (instance: Editor) => {
  const runtime = draws.get(instance);
  if (!runtime) throw new Error('Native Draw capture missing');
  return runtime;
};
function create(container: HTMLElement, main: IElement[], incrementalCompute = false) {
  const previous = captures.length;
  const instance = new Editor(container as HTMLDivElement, { main }, options(incrementalCompute));
  if (captures.length !== previous + 1)
    throw new Error('Expected a distinct native Draw per editor');
  draws.set(instance, captures[previous]!);
  return instance;
}
const saved = (instance = editor) => instance.command.getValue({ extraPickAttrs: ['id'] }).data;
function source(kind: 'plain' | 'table' | 'layout' | 'giant'): IElement[] {
  if (kind === 'giant')
    return [{ value: 'Giant ' + 'word 😀 é '.repeat(500), externalId: 'giant-run' }];
  const main: IElement[] = Array.from({ length: 80 }, (_, index) => ({
    value: `Line${String(index).padStart(3, '0')} measured words 😀 é repeated\n`,
    externalId: `line-${index}`,
    ...(kind === 'layout'
      ? { paragraphLayout: { before: 4, after: 7, indent: 12, firstLineIndent: 8 } }
      : {}),
  }));
  if (kind === 'table')
    main.splice(2, 0, {
      type: ElementType.TABLE,
      id: 'upstream-owned-table',
      value: '',
      colgroup: [{ width: 120 }, { width: 120 }],
      trList: [
        {
          id: 'upstream-owned-row',
          height: 40,
          tdList: [
            {
              id: 'upstream-owned-cell',
              colspan: 1,
              rowspan: 1,
              value: [{ value: 'Protected cell' }],
            },
            { id: 'upstream-neighbor', colspan: 1, rowspan: 1, value: [{ value: 'Neighbor' }] },
          ],
        },
      ],
    });
  return main;
}
const options = (incrementalCompute = false) => ({
  width: 460,
  height: 460,
  margins: [40, 40, 40, 40] as [number, number, number, number],
  defaultFont: 'Liberation Serif',
  defaultSize: 16,
  header: { disabled: true },
  footer: { disabled: true },
  lab: { incrementalCompute },
});
function mount(kind: 'plain' | 'table' | 'layout' | 'giant' = 'plain') {
  editor?.destroy();
  host.innerHTML = '';
  editor = create(host, source(kind));
  return snapshot();
}
function place(query: string) {
  const range = editor.command.getKeywordRangeList(query)[0]!;
  editor.command.executeSetPositionContext(range);
  editor.command.executeSetRange(range.startIndex, range.startIndex);
  editor.command.executeFocus({ range: editor.command.getRange() });
  return snapshot();
}
function point(query: string) {
  const range = editor.command.getKeywordRangeList(query)[0]!;
  const position = draw(editor).getPosition().getOriginalMainPositionList()[range.startIndex + 1]!;
  const paper = host.querySelector<HTMLCanvasElement>(`canvas[data-index="${position.pageNo}"]`)!;
  const rect = paper.getBoundingClientRect();
  const coordinate = position.coordinate;
  return {
    x: rect.left + (coordinate.leftTop[0] + coordinate.rightBottom[0]) / 2,
    y: rect.top + (coordinate.leftTop[1] + coordinate.rightBottom[1]) / 2,
    pageNo: position.pageNo,
  };
}
function snapshot() {
  return {
    range: editor.command.getRange(),
    tableContext: editor.command.getRangeContext()?.isTable,
    value: saved(),
    scrollY: window.scrollY,
  };
}
function rows(list: IRow[]) {
  return list.map((row) => ({
    width: row.width,
    height: row.height,
    ascent: row.ascent,
    startIndex: row.startIndex,
    rowIndex: row.rowIndex,
    rowFlex: row.rowFlex,
    offsetX: row.offsetX,
    offsetY: row.offsetY,
    paragraphLayout: row.paragraphLayout,
    paragraphStart: row.paragraphStart,
    count: row.elementList.length,
  }));
}
function layout(instance: Editor) {
  const runtime = draw(instance);
  return {
    data: instance.command.getValue().data,
    raw: rows(runtime.getRawRowList()),
    rows: rows(runtime.getRowList()),
    pages: runtime.getPageRowList().map(rows),
    positions: runtime.getPosition().getOriginalMainPositionList(),
  };
}
function differential(kind: 'plain' | 'table' | 'layout' | 'giant') {
  const containers = [document.createElement('div'), document.createElement('div')];
  containers.forEach((container) => document.body.append(container));
  const instances = containers.map((container, index) =>
    create(container, source(kind), index === 1),
  );
  let incrementalCalls = 0;
  const incremental = draw(instances[1]!).getIncrementalRowComputer();
  const original = incremental.tryCompute.bind(incremental);
  incremental.tryCompute = (...args) => {
    const result = original(...args);
    if (result) incrementalCalls++;
    return result;
  };
  try {
    const verify = () => {
      if (JSON.stringify(layout(instances[0]!)) !== JSON.stringify(layout(instances[1]!)))
        throw new Error(`Full/incremental ${kind} layout differs`);
    };
    verify();
    for (const index of [120, 350, 900]) {
      for (const instance of instances) {
        instance.command.executeSetRange(index, index);
        instance.command.executeInsertElementList([{ value: 'Insert 😀 é ' }]);
      }
      verify();
    }
    for (const instance of instances) instance.command.executeUndo();
    verify();
    for (const instance of instances) instance.command.executeRedo();
    verify();
    if (kind === 'plain' && incrementalCalls === 0)
      throw new Error('Plain fixture never exercised incremental layout');
    if (kind === 'layout' && incrementalCalls !== 0)
      throw new Error('Proser geometry did not use full layout fallback');
    return { kind, incrementalCalls, equivalent: true };
  } finally {
    instances.forEach((instance) => instance.destroy());
    containers.forEach((container) => container.remove());
  }
}
Object.assign(window, { upstreamAcceptance: { mount, place, point, snapshot, differential } });
