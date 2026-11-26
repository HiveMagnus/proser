'use client';
import { useState } from 'react';
import { paragraphsOf, visibleRun, type ProserDocument } from '@hivemagnus/proser-editor';
import { listImages, type ImageAssetRecord } from '@/lib/api';
import { insertDocumentImage } from '@/lib/document-image-editing';
export function DocumentImagePicker({
  bookId,
  document,
  disabled,
  onChange,
}: {
  bookId: string;
  document: ProserDocument;
  disabled?: boolean;
  onChange: (document: ProserDocument) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [assets, setAssets] = useState<ImageAssetRecord[]>([]);
  const [assetId, setAssetId] = useState('');
  const [blockId, setBlockId] = useState('');
  const [caret, setCaret] = useState(0);
  const [alt, setAlt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const paragraphs = paragraphsOf(document);
  const paragraph = paragraphs.find((item) => item.id === blockId) ?? paragraphs[0];
  const text =
    paragraph?.runs
      .filter((run) => visibleRun(run, document.changes, 'final'))
      .map((run) => (run.inlineImage ? '\ufffc' : run.text))
      .join('') ?? '';
  const load = async () => {
    setOpened(true);
    setBusy(true);
    setError(undefined);
    try {
      setAssets(
        (await listImages({ bookId, limit: 100 })).items.filter(
          (item) => item.bookId === bookId && /^[a-f0-9]{64}$/.test(item.sha256 ?? ''),
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Images could not load.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Insert manuscript image">
      <button type="button" disabled={disabled || busy} onClick={() => void load()}>
        Insert image
      </button>
      {opened && (
        <fieldset disabled={disabled || busy}>
          <legend>Choose an owned image and its position</legend>
          {error && <p role="alert">{error}</p>}
          {!assets.length && !busy && <p>No verified images are available for this book.</p>}
          <label>
            Image{' '}
            <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
              <option value="">Choose image</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.prompt ?? `Image ${asset.id}`}
                </option>
              ))}
            </select>
          </label>
          {assets.find((item) => item.id === assetId) && (
            <img
              src={assets.find((item) => item.id === assetId)!.url}
              alt="Selected image preview"
              className="max-h-40 max-w-full"
            />
          )}
          <label>
            Paragraph{' '}
            <select
              value={paragraph?.id ?? ''}
              onChange={(event) => {
                setBlockId(event.target.value);
                setCaret(0);
              }}
            >
              {paragraphs.map((item, index) => (
                <option key={item.id} value={item.id}>
                  Paragraph {index + 1}
                </option>
              ))}
            </select>
          </label>
          <label>
            Place the caret for the image{' '}
            <textarea
              value={text}
              readOnly
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            />
          </label>
          <label>
            Image description{' '}
            <input value={alt} maxLength={2000} onChange={(event) => setAlt(event.target.value)} />
          </label>
          <button
            type="button"
            disabled={!paragraph || !assetId}
            onClick={() => {
              try {
                const asset = assets.find((item) => item.id === assetId)!;
                onChange(
                  insertDocumentImage(
                    document,
                    paragraph!.id,
                    caret,
                    text,
                    { ...asset, sha256: asset.sha256! },
                    alt,
                    () => crypto.randomUUID(),
                  ),
                );
                setOpened(false);
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Image insertion failed.');
              }
            }}
          >
            Insert at caret
          </button>
          <button type="button" onClick={() => setOpened(false)}>
            Close image chooser
          </button>
        </fieldset>
      )}
    </section>
  );
}
