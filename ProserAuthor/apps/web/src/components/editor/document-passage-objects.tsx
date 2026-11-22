'use client';
import { useState, useEffect } from 'react';
import type {
  DocumentPassage,
  DocumentPassageOperation,
  DocumentImage,
} from '@cheftaco/proser-contracts';
import { listImages, type ImageAssetRecord } from '@/lib/api';
import { Button } from '@/components/ui/button';

/** Object controls submit exact Factory object/placement evidence. Runtime Canvas
 * coordinates and browser-created object IDs never leave the presentation layer. */
export function DocumentPassageObjects({
  bookId,
  passage,
  disabled,
  onOperations,
}: {
  bookId: string;
  passage: DocumentPassage;
  disabled: boolean;
  onOperations(operations: DocumentPassageOperation[]): Promise<void>;
}) {
  const [targetId, setTargetId] = useState(''),
    [rows, setRows] = useState(2),
    [columns, setColumns] = useState(2),
    [widths, setWidths] = useState('');
  const [assets, setAssets] = useState<ImageAssetRecord[]>([]),
    [assetId, setAssetId] = useState(''),
    [alt, setAlt] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const items = passage.items ?? [];
  const identity = (item: (typeof items)[number]) =>
    item.type === 'paragraph'
      ? passage.paragraphs[item.paragraphIndex]!.paragraph.id
      : item.type === 'image'
        ? item.image.id
        : item.type === 'pageBreak'
          ? item.pageBreak.id
          : item.id;
  const selected = items.find((item) => identity(item) === targetId) ?? items[0];
  const selectedImageAlt = selected?.type === 'image' ? selected.image.alt : undefined;
  useEffect(() => {
    if (selectedImageAlt !== undefined) setAlt(selectedImageAlt);
  }, [targetId, selectedImageAlt]);
  const id = () => crypto.randomUUID();
  const dispatch = async (operations: DocumentPassageOperation[]) => {
    setBusy(true);
    setError(undefined);
    try {
      await onOperations(operations);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to apply this exact object operation.',
      );
    } finally {
      setBusy(false);
    }
  };
  const loadImages = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setAssets(
        (await listImages({ bookId, limit: 100 })).items.filter(
          (asset) => asset.bookId === bookId && /^[a-f0-9]{64}$/.test(asset.sha256 ?? ''),
        ),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Images could not load.');
    } finally {
      setBusy(false);
    }
  };
  const asset = assets.find((item) => item.id === assetId);
  const image = (): Omit<DocumentImage, 'id' | 'type'> => {
    if (!asset?.sha256) throw new Error('Choose an owned immutable image.');
    const sourceWidth = asset.width ?? 600,
      sourceHeight = asset.height ?? 400,
      scale = Math.min(1, 600 / sourceWidth, 800 / sourceHeight);
    return {
      assetId: Number(asset.id),
      sha256: asset.sha256,
      alt,
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
    };
  };
  return (
    <section
      aria-label="Passage objects and table structure"
      className="space-y-3 rounded border border-border-muted p-3"
    >
      <h2 className="font-semibold">Objects and table structure</h2>
      {error && <p role="alert">{error}</p>}
      {passage.emptyPlacement && (
        <Button
          type="button"
          disabled={disabled || busy}
          onClick={() =>
            void dispatch([
              { id: id(), kind: 'insert-paragraph', placement: passage.emptyPlacement! },
            ])
          }
        >
          Add first paragraph
        </Button>
      )}
      <fieldset disabled={disabled || busy || !selected} className="space-y-3">
        <label>
          Position{' '}
          <select
            aria-label="Passage object position"
            value={selected ? identity(selected) : ''}
            onChange={(event) => setTargetId(event.target.value)}
          >
            {items.map((item, index) => (
              <option key={identity(item)} value={identity(item)}>
                {index + 1}.{' '}
                {item.type === 'tableSlice'
                  ? 'Table'
                  : item.type === 'paragraph'
                    ? 'Paragraph'
                    : item.type === 'pageBreak'
                      ? 'Page break'
                      : 'Image'}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            selected &&
            void dispatch([
              { id: id(), kind: 'insert-paragraph', placement: selected.placement.after },
            ])
          }
        >
          Add paragraph after
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              selected &&
              void dispatch([
                { id: id(), kind: 'insert-break', placement: selected.placement.after },
              ])
            }
          >
            Insert page break after
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <label>
            Rows{' '}
            <input
              aria-label="New table rows"
              type="number"
              min={1}
              max={20}
              value={rows}
              onChange={(event) => setRows(Number(event.target.value))}
            />
          </label>
          <label>
            Columns{' '}
            <input
              aria-label="New table columns"
              type="number"
              min={1}
              max={10}
              value={columns}
              onChange={(event) => setColumns(Number(event.target.value))}
            />
          </label>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              selected &&
              void dispatch([
                {
                  id: id(),
                  kind: 'insert-table',
                  placement: selected.placement.after,
                  widths: Array.from({ length: columns }, () => Math.min(200, 600 / columns)),
                  rows,
                },
              ])
            }
          >
            Insert table after
          </Button>
        </div>
        <Button type="button" variant="secondary" onClick={() => void loadImages()}>
          Choose owned image
        </Button>
        {assets.length > 0 && (
          <div className="space-y-2">
            <label>
              Image{' '}
              <select
                aria-label="Owned passage image"
                value={assetId}
                onChange={(event) => setAssetId(event.target.value)}
              >
                <option value="">Choose image</option>
                {assets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.prompt ?? `Image ${item.id}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Description{' '}
              <input
                value={alt}
                maxLength={2000}
                onChange={(event) => setAlt(event.target.value)}
              />
            </label>
            {asset && (
              <img
                src={`/api/images/${encodeURIComponent(asset.id)}/content`}
                alt="Selected owned image"
                className="max-h-40 max-w-full"
              />
            )}
            <Button
              type="button"
              disabled={!asset}
              onClick={() => {
                if (selected)
                  void dispatch([
                    {
                      id: id(),
                      kind: 'insert-image',
                      placement: selected.placement.after,
                      image: image(),
                    },
                  ]);
              }}
            >
              Insert image after
            </Button>
          </div>
        )}
        {selected?.type === 'image' && (
          <>
            <label>
              Image description{' '}
              <input
                value={alt}
                placeholder={selected.image.alt}
                maxLength={2000}
                onChange={(event) => setAlt(event.target.value)}
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void dispatch([
                  {
                    id: id(),
                    kind: 'update-image',
                    target: selected.source,
                    image: {
                      assetId: selected.image.assetId,
                      sha256: selected.image.sha256,
                      width: selected.image.width,
                      height: selected.image.height,
                      alt,
                    },
                  },
                ])
              }
            >
              Update image description
            </Button>
          </>
        )}
        {selected?.type === 'tableSlice' && (
          <div className="space-y-2">
            <label>
              Column widths{' '}
              <input
                aria-label="Passage table widths"
                value={widths}
                placeholder={selected.widths.join(', ')}
                onChange={(event) => setWidths(event.target.value)}
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void dispatch([
                  {
                    id: id(),
                    kind: 'table-widths',
                    target: selected.source,
                    widths: widths.split(',').map((value) => Number(value.trim())),
                  },
                ])
              }
            >
              Update widths
            </Button>
            {selected.rows.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-2">
                <span>Row {row.ordinal + 1}</span>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void dispatch([
                      {
                        id: id(),
                        kind: 'table-insert-row',
                        target: selected.source,
                        rowId: row.id,
                        side: 'after',
                      },
                    ])
                  }
                >
                  Add row after
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void dispatch([
                      {
                        id: id(),
                        kind: 'table-remove-row',
                        target: selected.source,
                        rowId: row.id,
                        rowHash: row.sourceHash,
                      },
                    ])
                  }
                >
                  Remove row
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void dispatch([
                  {
                    id: id(),
                    kind: 'table-insert-column',
                    target: selected.source,
                    column: selected.columnCount,
                    width: 120,
                  },
                ])
              }
            >
              Add column at end
            </Button>
            {selected.columnHashes.map((columnHash, column) => (
              <Button
                key={column}
                type="button"
                variant="secondary"
                onClick={() =>
                  void dispatch([
                    {
                      id: id(),
                      kind: 'table-remove-column',
                      target: selected.source,
                      column,
                      columnHash,
                    },
                  ])
                }
              >
                Remove column {column + 1}
              </Button>
            ))}
          </div>
        )}
        {selected && selected.type !== 'paragraph' && (
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              void dispatch([{ id: id(), kind: 'remove-object', target: selected.source }])
            }
          >
            Remove selected object
          </Button>
        )}
      </fieldset>
    </section>
  );
}
